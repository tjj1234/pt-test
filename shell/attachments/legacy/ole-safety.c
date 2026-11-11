/* Policy guard over Debian catdoc's existing OLE parser; not a converter. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include "catdoc.h"
extern unsigned char *properties;
extern long propNumber;
int main(int argc,char **argv){
 if(argc!=3)return 65;
 FILE *input=fopen(argv[2],"rb");if(!input)return 65;
 FILE *ole=ole_init(input,NULL,0);if(!ole||!properties||propNumber<1||propNumber>4096)return 65;
 int found=0;
 for(long i=0;i<propNumber;i++){
  unsigned char *entry=properties+i*128;int type=entry[0x42];if(type==0)continue;
  int bytes=getshort(entry,0x40);if(bytes<2||bytes>64||bytes%2)return 65;
  char name[33]={0};int ascii=1;for(int j=0;j<bytes/2-1;j++){if(entry[j*2+1]||entry[j*2]==0){ascii=0;break;}name[j]=(char)entry[j*2];}
  if(!ascii)continue;
  if(!strcasecmp(name,"EncryptedPackage")||!strcasecmp(name,"EncryptionInfo")||!strcasecmp(name,"EncryptedSummary"))return 66;
  if(!strcasecmp(name,"VBA")||!strcasecmp(name,"Macros")||!strcasecmp(name,"_VBA_PROJECT")||!strcasecmp(name,"PROJECT")||!strcasecmp(name,"PROJECTwm")||!strcasecmp(name,"ObjectPool")||!strcasecmp(name,"Ole10Native")||!strcasecmp(name,"LinkInfo"))return 67;
  if((!strcmp(argv[1],"doc")&&!strcasecmp(name,"WordDocument"))||(!strcmp(argv[1],"xls")&&(!strcasecmp(name,"Workbook")||!strcasecmp(name,"Book")))||(!strcmp(argv[1],"ppt")&&!strcasecmp(name,"PowerPoint Document")))found=1;
 }
 if(!found)return 68;
 FILE *stream;
 while((stream=ole_readdir(ole))!=NULL){
  const char *name=((oleEntry*)stream)->name;
  if(!strcmp(argv[1],"doc")&&!strcasecmp(name,"WordDocument")&&ole_open(stream)>=0){unsigned char fib[12];if(ole_read(fib,1,12,stream)!=12)return 65;if(getshort(fib,10)&0x0100)return 66;}
  if(!strcmp(argv[1],"xls")&&(!strcasecmp(name,"Workbook")||!strcasecmp(name,"Book"))&&ole_open(stream)>=0){
   unsigned char header[4];unsigned long consumed=0,limit=((oleEntry*)stream)->length;int count=0;
   while(consumed+4<=limit){if(++count>100000||ole_read(header,1,4,stream)!=4)return 65;unsigned int kind=getshort(header,0),size=getshort(header,2);consumed+=4;if(kind==0x002f)return 66;if(consumed+size>limit)return 65;if(ole_seek(stream,size,SEEK_CUR)<0)return 65;consumed+=size;}
  }
  ole_close(stream);
 }
 ole_finish();fclose(ole);puts("OLE_SAFE");return 0;
}
