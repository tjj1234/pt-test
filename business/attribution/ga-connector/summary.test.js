"use strict";
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createGaConnector}=require('./index');
const {renderReportHTML}=require('../../../shell/public/report-render');
const args={metrics:['eventCount','activeUsers'],dimensions:['date'],dateRange:{startDate:'2026-10-01',endDate:'2026-10-02'}};
function response(extra={}) {
 return {dimensionHeaders:[{name:'date'}],metricHeaders:[{name:'eventCount'},{name:'activeUsers'}],rows:[{dimensionValues:[{value:'20261001'}],metricValues:[{value:'10'},{value:'8'}]},{dimensionValues:[{value:'20261002'}],metricValues:[{value:'20'},{value:'9'}]}],rowCount:2,...extra};
}
function connector(r) {
 return createGaConnector({store:{get:async()=>({property:'123',refreshToken:'test'})},google:{refresh:async()=>({access_token:'test'}),runReport:async(property,token,body)=>{assert.deepEqual(body.metricAggregations,['TOTAL']);return r;}}});
}
test('table and summary expose GA totals without summing distinct users or truncated rows',async()=>{
 const r=response({rowCount:10001,totals:[{metricValues:[{value:'12345'},{value:'12'}]}]});
 for(const format of ['table','summary',undefined]) {
  const report=await connector(r).query('tenant',{...args,...(format?{format}:{})});
  assert.deepEqual(report.stats.find(([k])=>k==='汇总 · eventCount'),['汇总 · eventCount','GA TOTAL 12345']);
  assert.deepEqual(report.stats.find(([k])=>k==='汇总 · activeUsers'),['汇总 · activeUsers','GA TOTAL 12']);
  assert.match(report.stats.find(([k])=>k==='汇总口径')[1],/完整查询/);
  if(format==='table') {assert.deepEqual(report.table.rows,[['20261001','10','8'],['20261002','20','9']]);assert.match(renderReportHTML(report),/12345/);} else assert.equal(report.table,undefined);
 }
});
test('missing totals exposes scoped row aggregates and mean, with decimal and zero values',async()=>{
 const r=response({rows:[{dimensionValues:[{value:'20261001'}],metricValues:[{value:'0.1'},{value:'0'}]},{dimensionValues:[{value:'20261002'}],metricValues:[{value:'0.2'},{value:'0'}]}],rowCount:10001});
 const report=await connector(r).query('tenant',{...args,format:'table'});
 assert.equal(report.stats.find(([k])=>k==='汇总 · eventCount')[1],'已返回行合计 0.3；行均值 0.15');
 assert.equal(report.stats.find(([k])=>k==='汇总 · activeUsers')[1],'已返回行合计 0；行均值 0');
 assert.match(report.stats.find(([k])=>k==='汇总口径')[1],/非全量/);
});
test('empty results do not invent zero totals; valid upstream zero totals remain visible',async()=>{
 const empty=response({rows:[],rowCount:0});
 const report=await connector(empty).query('tenant',{...args,format:'table'});
 assert.equal(report.table,undefined);assert.equal(report.stats.find(([k])=>k==='汇总 · eventCount')[1],'无数据（不等于0）');
 const zero=await connector({...empty,totals:[{metricValues:[{value:'0'},{value:'0'}]}]}).query('tenant',args);
 assert.equal(zero.stats.find(([k])=>k==='汇总 · eventCount')[1],'GA TOTAL 0');
});
test('malformed metric values and totals fail closed',async()=>{
 for(const totals of [[{metricValues:[{value:'NaN'},{value:'1'}]}],[{metricValues:[]}],[{}]]) await assert.rejects(connector(response({totals})).query('tenant',args),{code:'GOOGLE_BAD_RESPONSE'});
 const r=response();r.rows[0].metricValues[0].value='';await assert.rejects(connector(r).query('tenant',args),{code:'GOOGLE_BAD_RESPONSE'});
});
test('actual DSH GA renderer exposes stats to model while keeping table in report',async()=>{
 const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
 const source=fs.readFileSync(path.resolve(__dirname,'../../../shell/persistent-runner.mjs'),'utf8');
 const ga=source.slice(source.indexOf('name: "ga_query"'));
 const start=ga.indexOf('render: (_args, value) => {')+'render: '.length;
 const end=ga.indexOf('\n                  },',start)+ '\n                  }'.length;
 assert.ok(start>=0&&end>start);
 const render=vm.runInNewContext('('+ga.slice(start,end)+')');
 const report=await connector(response({totals:[{metricValues:[{value:'30'},{value:'12'}]}]})).query('tenant',{...args,format:'table'});
 const result=render({},report);
 assert.match(result[0].text,/汇总 · activeUsers: GA TOTAL 12/);assert.match(result[0].text,/汇总 · eventCount: GA TOTAL 30/);
 assert.doesNotMatch(result[0].text,/20261001/);assert.equal(report.table.rows.length,2);
});
