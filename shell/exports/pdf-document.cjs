'use strict';
const path=require('node:path');
const PDFDocument=require('pdfkit');
const {guardStructuredDocumentInput}=require('./document-input-guard-candidate.cjs');
function renderPdf(input){
 const {normalized:document}=guardStructuredDocumentInput(input,{maxBytes:4*1024*1024});
 return new Promise((resolve,reject)=>{
  const pdf=new PDFDocument({size:'A4',margin:48,info:{Title:document.title},autoFirstPage:true,compress:true});
  const chunks=[];let size=0,failed=false,pages=1;
  const stop=()=>{if(failed)return;failed=true;pdf.destroy();reject(Error('PDF export failed'));};
  pdf.on('error',stop);pdf.on('data',chunk=>{size+=chunk.length;if(size>5*1024*1024)return stop();chunks.push(chunk);});
  pdf.on('end',()=>{if(!failed)resolve(Buffer.concat(chunks));});
  pdf.on('pageAdded',()=>{if(++pages>200)stop();});
  try{
   pdf.font(path.join(__dirname,'fonts/NotoSansCJKsc-Regular.otf'));
   const text=(value,fontSize=11)=>{
    if(failed)throw Error('limit');
    const content=String(value??'');
    // Fail instead of replacing an unsupported glyph with an invisible box.
    for(const c of content){const cp=c.codePointAt(0);if(cp!==9&&cp!==10&&cp!==13&&!pdf._font.font.hasGlyphForCodePoint(cp))throw Error('glyph');}
    pdf.fontSize(fontSize).text(content,{lineGap:3});pdf.moveDown(0.3);
   };
   const table=t=>{if(t.headers)text(t.headers.join(' | '));for(const row of t.rows)text(row.map(c=>c??'').join(' | '));};
   text(document.title,18);
   if(document.author)text(document.author);if(document.date)text(document.date);
   for(const section of document.sections||[]){if(section.heading)text(section.heading,14);for(const p of section.paragraphs||[])text(p);if(section.table)table(section.table);}
   if(document.table)table(document.table);
   pdf.end();
  }catch{stop();}
 });
}
module.exports={renderPdf};
