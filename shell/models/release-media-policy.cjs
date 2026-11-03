'use strict';
const isSeedance=id=>typeof id==='string'&&/seedance/i.test(id);
const allowedTask=(task,mode=process.env.PT_MEDIA_GENERATION)=>mode!=='off'&&(mode!=='standard3'||['text2image','image2image','text2video'].includes(task));
const visibleModels=models=>(models||[]).filter(model=>!isSeedance(model.id));
module.exports={isSeedance,allowedTask,visibleModels};
