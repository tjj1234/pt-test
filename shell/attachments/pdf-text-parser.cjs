'use strict';
// Called only inside the existing bounded, disposable parsing/search workers.
const fail=code=>Object.assign(new Error('PDF content could not be extracted'),{code});
async function extractPdfText(bytes){
 if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>20*1024*1024)throw fail('OFFICE_INPUT_LIMIT');
 if(!bytes.subarray(0,1024).includes(Buffer.from('%PDF-')))throw fail('OFFICE_FORMAT_MISMATCH');
 const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
 const task=getDocument({data:Uint8Array.from(bytes),useWorkerFetch:false,useSystemFonts:false,disableFontFace:true,isEvalSupported:false,stopAtErrors:true,verbosity:0});
 let pdf;
 try{
  pdf=await task.promise;
  if(!Number.isSafeInteger(pdf.numPages)||pdf.numPages<1||pdf.numPages>200)throw fail('OFFICE_PAGE_LIMIT');
  const blocks=[];let textBytes=0,emptyPages=0;
  for(let number=1;number<=pdf.numPages;number++){
   const page=await pdf.getPage(number);let text='';
   try{
    const stream=page.streamTextContent({disableNormalization:false}),reader=stream.getReader();
    try{
     for(;;){const {done,value}=await reader.read();if(done)break;
      for(const item of value.items){if(typeof item.str!=='string')continue;
       const part=item.str+(item.hasEOL?'\n':' ');textBytes+=Buffer.byteLength(part);
       if(textBytes>5*1024*1024)throw fail('OFFICE_TEXT_LIMIT');
       text+=part;
      }
     }
    }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
   }finally{page.cleanup();}
   text=text.trim();if(!text)emptyPages++;
   blocks.push({index:number,text,locator:{kind:'pdf-page',page:number}});
  }
  if(emptyPages===pdf.numPages)throw fail('OFFICE_PDF_OCR_REQUIRED');
  return {format:'pdf',text:blocks.map(b=>b.text).join('\n\n'),blocks,locatorKind:'pdf-page',pageCount:pdf.numPages,warningCount:emptyPages,
   limitations:'Text layer only; images, diagrams and scanned pages require OCR. Reading order follows embedded PDF text.'};
 }catch(error){if(/^OFFICE_[A-Z_]+$/.test(error.code||''))throw error;throw fail('OFFICE_PDF_PARSE_FAILED');}
 finally{await task.destroy();}
}
module.exports={extractPdfText};
