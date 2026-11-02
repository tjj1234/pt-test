'use strict';
const {createRequire} = require('node:module');
const path = require('node:path');
const {zipSync, strToU8} = createRequire(path.resolve(__dirname, '../../shell/package.json'))('fflate');
const relns = 'http://schemas.openxmlformats.org/package/2006/relationships';
const officens = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
function pack(entries) {
  return Buffer.from(zipSync(Object.fromEntries(Object.entries({'[Content_Types].xml': '<Types/>', ...entries}).map(([name, text]) => [name, strToU8(text)]))));
}
function spreadsheet({target = 'worksheets/data.xml', external = false, sheetXml, sharedXml} = {}) {
  return pack({
    'xl/workbook.xml': `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${officens}"><sheets><sheet name="资料" sheetId="1" r:id="r1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${relns}"><Relationship Id="r1" Type="${officens}/worksheet" Target="${target}"${external ? ' TargetMode="External"' : ''}/></Relationships>`,
    'xl/sharedStrings.xml': sharedXml || '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>编号00123中文</t></si></sst>',
    'xl/worksheets/data.xml': sheetXml || '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>45292</v></c><c r="C1"><f>SUM(B1:B2)</f><v>10</v></c><c r="D1" t="inlineStr"><is><t>=IMPORTXML(private)</t></is></c></row></sheetData></worksheet>',
  });
}
function presentation({target = 'slides/renamed.xml', external = false} = {}) {
  return pack({
    'ppt/presentation.xml': `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${officens}"><p:sldIdLst><p:sldId id="256" r:id="r1"/></p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': `<Relationships xmlns="${relns}"><Relationship Id="r1" Type="${officens}/slide" Target="${target}"${external ? ' TargetMode="External"' : ''}/></Relationships>`,
    'ppt/slides/renamed.xml': '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>中文演示第一段</a:t></a:r></a:p><a:p><a:r><a:t>来源与待办00123</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
  });
}
module.exports = {spreadsheet, presentation};
