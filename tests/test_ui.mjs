import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../', import.meta.url));
const out = root + '.test-artifacts';
await mkdir(out, {recursive:true});
const alarm = id => ({history_id:String(id),alarm_id:id,tag_name:'Alarm_'+id,kepware_path:'Factory.Line.Alarm_'+id,value:1,state:'ACTIVE',activated_at:'2026-09-19T09:00:00'});
let alarms = Array.from({length:125},(_,i)=>alarm(125-i));
let offline = false, slowId = null;
const requests = [];
const knowledge = {sections:{description:{text:'Conveyor overload. Inspect drive and motor.',images:[]},how_to_check:{text:'Check the drive fault code and inspect the conveyor.',images:[]},safety_warning:{text:'Isolate equipment before inspection.',images:[]}}};
const server = createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost'); requests.push(url.pathname+url.search);
 if(url.pathname.startsWith('/api/')) {
  res.setHeader('Content-Type','application/json');
  if(url.pathname.endsWith('/history')) {
   const before=url.searchParams.get('before'); const filtered=alarms.filter(a=>!before||BigInt(a.history_id)<BigInt(before));
   res.end(JSON.stringify({alarms:filtered.slice(0,50),next_cursor:filtered.length>50?filtered[49].history_id:null}));return;
  }
  if(url.pathname.endsWith('/pareto')) {
   const window=url.searchParams.get('window');
   const groups=window==='48h'?[]:window==='1w'?[{alarm_id:1,tag_name:'Single',kepware_path:'F.L.Single',count:8,percentage:100,cumulative_percentage:100}]:Array.from({length:40},(_,i)=>({alarm_id:i,tag_name:'Alarm_'+i,kepware_path:'Factory.Line.Alarm_'+i,count:40-i,percentage:(40-i)/820*100,cumulative_percentage:((i+1)*(80-i)/2)/820*100}));
   res.end(JSON.stringify({window,total:groups.reduce((n,g)=>n+g.count,0),alarms:groups}));return;
  }
  if(url.pathname.endsWith('/activity')) {res.end(JSON.stringify({has_activity:!offline,tag_name:'Alarm activity',state:'ACTIVE'}));return;}
  const id=url.pathname.includes('/history/')?url.pathname.split('/').at(-1):alarms[0].history_id;
  if(id===slowId) await new Promise(r=>setTimeout(r,500));
  res.end(JSON.stringify({has_alarm:true,alarm:alarms.find(a=>a.history_id===id),knowledge:offline?null:knowledge,knowledge_unavailable:offline}));return;
 }
 const path=url.pathname==='/'?'templates/index.html':url.pathname.slice(1);
 if(!['templates/index.html','static/app.css','static/app.js'].includes(path)){res.writeHead(404).end();return;}
 res.setHeader('Content-Type',path.endsWith('.css')?'text/css':path.endsWith('.js')?'text/javascript':'text/html');res.end(await readFile(root+path));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const chrome=spawn(process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-port=0',`--user-data-dir=${out}/chrome-${Date.now()}`,'about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
const debuggerUrl=await new Promise((resolve,reject)=>{let log='';const timeout=setTimeout(()=>reject(Error('Chrome startup timed out')),15000);chrome.stderr.on('data',chunk=>{log+=chunk;const match=log.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(match){clearTimeout(timeout);resolve(match[1]);}});chrome.on('error',reject);});
const port=new URL(debuggerUrl).port;
const tabs=await(await fetch(`http://127.0.0.1:${port}/json`)).json();
const ws=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);
await new Promise(r=>ws.addEventListener('open',r,{once:true}));
let id=0;const pending=new Map();
ws.addEventListener('message',({data})=>{const m=JSON.parse(data);if(pending.has(m.id)){const {resolve,reject}=pending.get(m.id);pending.delete(m.id);m.error?reject(m.error):resolve(m.result);}});
const call=(method,params={})=>new Promise((resolve,reject)=>{pending.set(++id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
const evaluate=async(expression)=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
const wait=async(expression)=>{for(let i=0;i<100;i++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,50));}throw Error('Timeout: '+expression);};
const click=async id=>evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
const shot=async name=>writeFile(`${out}/${name}.png`,Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'));
const checks=[];
try {
 await call('Emulation.setDeviceMetricsOverride',{width:1920,height:1080,deviceScaleFactor:1,mobile:false});
 await call('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/`});
 await wait('typeof historyLoaded !== "undefined" && historyLoaded && !historyBusy');
 await evaluate('document.getElementById("auto-refresh").value="0";startPolling()');
 assert.equal(await evaluate('historyRows.length'),50);assert.equal(await evaluate('historyRows[0].history_id'),'125');
 await click('open-history');
 await evaluate('document.getElementById("history-scroll").scrollTop=500');
 await wait('historyRows.length>=100 && !historyBusy');
 assert.equal(await evaluate('new Set(historyRows.map(a=>a.history_id)).size'),100);
 const scroll=await evaluate('document.getElementById("history-scroll").scrollTop');
 await evaluate('loadHistoryDetail("90")');
 assert.equal(await evaluate('document.getElementById("history-scroll").scrollTop'),scroll);
 await evaluate('refreshAll()');
 assert.equal(await evaluate('document.getElementById("history-scroll").scrollTop'),scroll);
 assert.equal(await evaluate('selectedHistoryId'),'90');
 checks.push('initial newest 50, scroll loads older, no duplicates, selection and refresh preserve scroll');
 await click('load-older');await wait('!historyBusy');
 assert.equal(await evaluate('historyRows.length'),125);
 assert.equal(await evaluate('olderCursor'),null);
 assert.equal(await evaluate('document.getElementById("load-older").disabled'),true);
 assert.equal(await evaluate('historyRows.every((r,i)=>i===0 || BigInt(historyRows[i-1].history_id)>BigInt(r.history_id))'),true);
 checks.push('stable descending order and end of history');
 await click('open-pareto');await wait('document.querySelectorAll("#pareto-body tr").length===40');
 assert.equal(await evaluate('paretoMode'),true);
 await evaluate('refreshAll()');assert.equal(await evaluate('paretoMode'),true);
 assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
 assert.equal(await evaluate('document.querySelectorAll("#pareto-chart rect").length'),30);
 await shot('pareto-1920x1080');
 await click('back-alarm');assert.equal(await evaluate('selectedHistoryId'),'90');
 await click('open-pareto');
 for (const window of ['48h','1w','1m','24h']) {
  await evaluate(`document.getElementById('pareto-window').value='${window}';loadPareto()`);
  assert.equal(await evaluate('paretoMode'),true);
  assert.ok(requests.includes('/api/alarm-help/pareto?window='+window));
  if(window==='48h') assert.equal(await evaluate('document.querySelectorAll("#pareto-chart svg").length'),0);
  if(window==='1w') assert.equal(await evaluate('document.querySelectorAll("#pareto-body tr").length'),1);
 }
 checks.push('Pareto button, four windows, empty/single/many groups, back restoration, refresh stays in Pareto, local chart overflow');
 // An older response started before a new occurrence must not replace it.
 slowId='80';await evaluate('void loadHistoryDetail("80")');
 alarms.unshift(alarm(126));
 await evaluate('loadHistory()');await wait('selectedHistoryId==="126"');
 await new Promise(r=>setTimeout(r,600));
 assert.equal(await evaluate('paretoMode'),false);
 assert.equal(await evaluate('selectedHistoryId'),'126');
 assert.equal(await evaluate('document.getElementById("history-scroll").scrollTop'),0);
 assert.equal(await evaluate('document.querySelector("#history-body tr.selected").dataset.historyId'),'126');
 await shot('new-alarm-1920x1080');
 await click('open-pareto');alarms[0].state='CLEARED';alarms[0].value=0;
 await evaluate('refreshAll()');assert.equal(await evaluate('paretoMode'),true);
 await evaluate('loadHistoryDetail("90")');assert.equal(await evaluate('paretoMode'),true);assert.equal(await evaluate('selectedHistoryId'),'126');
 checks.push('new occurrence overrides Pareto, selects newest, stale detail discarded; clear/value/old selection do not exit Pareto');
 offline=true;await evaluate('loadPareto()');assert.equal(await evaluate('document.querySelectorAll("#pareto-body tr").length'),40);
 await click('back-alarm');await evaluate('loadHistoryDetail("90")');
 assert.ok((await evaluate('document.getElementById("detail-status").textContent')).includes('unavailable'));
 assert.equal(await evaluate('historyRows.length'),126);
 checks.push('history and Pareto survive unavailable Tag Knowledge');
 // More than one page arriving between polls must not create a gap.
 alarms.unshift(...Array.from({length:70},(_,i)=>alarm(196-i)));
 await evaluate('loadHistory()');await wait('!historyBusy');
 assert.equal(await evaluate('historyRows.length'),196);
 assert.equal(await evaluate('new Set(historyRows.map(a=>a.history_id)).size'),196);
 checks.push('refresh fills multiple-page gap without duplicates');
 console.log(JSON.stringify({passed:checks.length,checks}));
 await writeFile(out+'/ui-results.json',JSON.stringify({passed:checks.length,checks},null,2));
} finally { ws.close();server.close();chrome.kill(); }
