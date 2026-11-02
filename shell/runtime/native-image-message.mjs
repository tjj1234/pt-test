// Host transport policy only. Image validation, normalization, storage and
// provider projection remain owned by the locked DSH attachment service.
import {admitEncodedImages} from '@deepseek-ai/dsh-attachment';
import {createUserMessage} from '@deepseek-ai/dsh-llm';

const MAX_IMAGES=4, MAX_BYTES=10*1024*1024;
const fail=()=>Object.assign(new Error('Native image input is invalid'),{code:'NATIVE_IMAGE_INPUT_INVALID'});
export async function nativeImageMessage({attachments,text,images=[],signal}={}){
 signal?.throwIfAborted();
 if(typeof text!=='string'||!text.trim()||!Array.isArray(images)||images.length>MAX_IMAGES)throw fail();
 let encodedBytes=0,decodedBytes=0;
 const batch=images.map(image=>{
  if(!image||typeof image!=='object'||Object.keys(image).some(k=>!['data','mediaType','name'].includes(k))||
    typeof image.data!=='string'||!image.data.length||
    !['image/png','image/jpeg','image/webp','image/gif'].includes(image.mediaType)||
    (image.name!==undefined&&(typeof image.name!=='string'||image.name.length>255)))throw fail();
  encodedBytes+=image.data.length;
  decodedBytes+=Math.floor(image.data.length*3/4)-(image.data.endsWith('==')?2:image.data.endsWith('=')?1:0);
  if(encodedBytes>4*Math.ceil(MAX_BYTES/3)||decodedBytes>MAX_BYTES)throw fail();
  return {...image};
 });
 if(batch.length&&typeof attachments?.saveImages!=='function')throw fail();
 // DSH enforces canonical base64 and fully decodes the actual raster before
 // publishing durable references. No URL or caller-supplied reference accepted.
 const refs=batch.length?await admitEncodedImages(attachments,batch):[];
 signal?.throwIfAborted();
 return createUserMessage({content:[{type:'text',text},...refs.map(attachment=>({type:'image',attachment}))],source:{kind:'user'}});
}
