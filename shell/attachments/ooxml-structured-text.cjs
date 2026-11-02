'use strict';
// Text extraction only. Original sheet/cell and slide/paragraph positions are
// preserved; formulas, macros, relationships and embedded objects never run.
const path = require('node:path');
const {unzipSync} = require('fflate');
const {DOMParser} = require('@xmldom/xmldom');
const SS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const DRAW = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const fail = code => Object.assign(new Error('Office structure is unsupported or invalid'), {code});
const nodes = (element, ns, tag) => Array.from(element.getElementsByTagNameNS(ns, tag));
function parseXml(bytes) {
  if (!bytes || bytes.length > 8 * 1024 * 1024) throw fail('OFFICE_XML_LIMIT');
  let text;
  try { text = new TextDecoder('utf-8', {fatal: true}).decode(bytes); } catch { throw fail('OFFICE_XML_INVALID'); }
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw fail('OFFICE_XML_DECLARATION_UNSUPPORTED');
  let invalid = false;
  const document = new DOMParser({errorHandler: {warning: () => { invalid = true; }, error: () => { invalid = true; }, fatalError: () => { invalid = true; }}}).parseFromString(text, 'application/xml');
  if (invalid || !document?.documentElement) throw fail('OFFICE_XML_INVALID');
  return document;
}
function extractStructuredOffice(bytes, format, archive) {
  const selected = name => format === 'xlsx'
    ? name === 'xl/workbook.xml' || name === 'xl/_rels/workbook.xml.rels' || name === 'xl/sharedStrings.xml' || /^xl\/worksheets\/[^/]+\.xml$/.test(name)
    : name === 'ppt/presentation.xml' || name === 'ppt/_rels/presentation.xml.rels' || /^ppt\/slides\/[^/]+\.xml$/.test(name);
  const files = unzipSync(bytes, {filter: file => selected(file.name)});
  const blocks = []; let chars = 0;
  function add(text, locator) {
    if (!text) return;
    chars += text.length;
    if (chars > 2 * 1024 * 1024 || blocks.length >= 10000) throw fail('OFFICE_TEXT_LIMIT');
    blocks.push({index: blocks.length + 1, text, locator});
  }
  function orderedParts(main, relfile, namespace, elementName, kind, prefix, maxParts) {
    const document = parseXml(files[main]), relationships = parseXml(files[relfile]);
    const byId = new Map();
    for (const relation of nodes(relationships, REL, 'Relationship')) {
      const id = relation.getAttribute('Id'), target = relation.getAttribute('Target');
      if (byId.has(id)) throw fail('OFFICE_RELATIONSHIP_INVALID');
      byId.set(id, {target, type: relation.getAttribute('Type'), external: relation.getAttribute('TargetMode') === 'External'});
    }
    const list = nodes(document, namespace, elementName);
    if (list.length > maxParts) throw fail('OFFICE_PART_LIMIT');
    return list.map((element, index) => {
      const relation = byId.get(element.getAttributeNS(OFFICE_REL, 'id'));
      if (!relation || relation.external || relation.type !== OFFICE_REL + '/' + kind || !relation.target || /[\\\x00-\x1f?#]/.test(relation.target)) throw fail('OFFICE_RELATIONSHIP_INVALID');
      const target = path.posix.normalize(relation.target.startsWith('/') ? relation.target.slice(1) : path.posix.join(prefix, relation.target));
      if (!target.startsWith(prefix + '/') || !selected(target) || !files[target]) throw fail('OFFICE_RELATIONSHIP_INVALID');
      return {element, index: index + 1, target};
    });
  }
  let parts;
  if (format === 'xlsx') {
    if (!archive.names.includes('xl/workbook.xml')) throw fail('OFFICE_FORMAT_MISMATCH');
    let strings = [];
    if (files['xl/sharedStrings.xml']) {
      const entries = nodes(parseXml(files['xl/sharedStrings.xml']), SS, 'si');
      if (entries.length > 50000) throw fail('OFFICE_CELL_LIMIT');
      strings = entries.map(entry => nodes(entry, SS, 't').map(node => node.textContent).join(''));
    }
    parts = orderedParts('xl/workbook.xml', 'xl/_rels/workbook.xml.rels', SS, 'sheet', 'worksheet', 'xl', 64);
    let cellCount = 0;
    for (const part of parts) {
      if (!part.element.getAttribute('name') || part.element.getAttribute('name').length > 128) throw fail('OFFICE_SHEET_INVALID');
      const sheet = parseXml(files[part.target]), seen = new Set();
      for (const cell of nodes(sheet, SS, 'c')) {
        if (++cellCount > 50000) throw fail('OFFICE_CELL_LIMIT');
        const coordinate = cell.getAttribute('r'), type = cell.getAttribute('t') || 'n';
        if (!/^[A-Z]{1,3}[1-9][0-9]{0,6}$/.test(coordinate) || seen.has(coordinate)) throw fail('OFFICE_CELL_INVALID');
        seen.add(coordinate);
        const formula = nodes(cell, SS, 'f')[0], value = nodes(cell, SS, 'v')[0]?.textContent || '';
        let text = value;
        if (type === 's') {
          if (!/^(0|[1-9][0-9]{0,5})$/.test(value) || !Object.hasOwn(strings, Number(value))) throw fail('OFFICE_SHARED_STRING_INVALID');
          text = strings[Number(value)];
        } else if (type === 'inlineStr') text = nodes(cell, SS, 't').map(node => node.textContent).join('');
        else if (!['n', 'b', 'str', 'e', 'd'].includes(type)) throw fail('OFFICE_CELL_TYPE_UNSUPPORTED');
        if (formula) text = `FORMULA_TEXT=${formula.textContent}; CACHED_VALUE=${text || '[unavailable]'}`;
        add(text, {kind: 'sheet-cell', sheet: part.index, sheetName: part.element.getAttribute('name'), cell: coordinate, valueType: type, formula: Boolean(formula)});
      }
    }
  } else if (format === 'pptx') {
    if (!archive.names.includes('ppt/presentation.xml')) throw fail('OFFICE_FORMAT_MISMATCH');
    parts = orderedParts('ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels', 'http://schemas.openxmlformats.org/presentationml/2006/main', 'sldId', 'slide', 'ppt', 256);
    for (const part of parts) {
      const paragraphs = nodes(parseXml(files[part.target]), DRAW, 'p');
      if (paragraphs.length > 10000) throw fail('OFFICE_BLOCK_LIMIT');
      for (let index = 0; index < paragraphs.length; index++) {
        const text = nodes(paragraphs[index], DRAW, 't').map(node => node.textContent).join('');
        add(text, {kind: 'slide-paragraph', slide: part.index, paragraph: index + 1});
      }
    }
  } else throw fail('OFFICE_FORMAT_UNSUPPORTED');
  return {format, text: blocks.map(block => block.text).join('\n\n'), blocks, locatorKind: format === 'xlsx' ? 'sheet-cell-raw-value' : 'slide-paragraph-text-only',
    warningCount: 1, expandedBytes: archive.expandedBytes, partCount: parts.length,
    limitations: format === 'xlsx' ? 'Raw values only; no formula evaluation or implicit date conversion; styles/charts not interpreted' : 'Slide text only; notes, charts, images, audio and animations not interpreted'};
}
module.exports = {extractStructuredOffice};
