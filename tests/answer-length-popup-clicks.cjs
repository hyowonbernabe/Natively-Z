// Run after a production frontend/Electron build on a Windows desktop. Uses isolated userData.
if(process.platform !== 'win32'){console.log('Requires Windows desktop for the physical mouse-click regression.');process.exit(0);}
const {_electron:electron}=require('playwright');const fs=require('fs'),path=require('path'),assert=require('assert/strict');
(async()=>{
 const dir=path.resolve('.agent/userdata-answer-length-'+Date.now());fs.mkdirSync(dir,{recursive:true});
 const voice={enabled:true,text:'Use everyday words and explain things clearly.'};fs.writeFileSync(path.join(dir,'settings.json'),JSON.stringify({outputStyle:voice}));
 const env={...process.env,NODE_ENV:'production',NATIVELY_AGENT_USER_DATA:dir};delete env.ELECTRON_RUN_AS_NODE;
 const app=await electron.launch({args:[path.resolve('.'),`--user-data-dir=${dir}`],env,timeout:45000});
 try{
 let launcher;for(let i=0;i<100;i++){launcher=app.windows().find(p=>p.url().includes('window=launcher'));if(launcher)break;await new Promise(r=>setTimeout(r,200));}assert.ok(launcher);
 await launcher.getByRole('button',{name:/^Mock interview/}).waitFor();await new Promise(r=>setTimeout(r,1500));
 await launcher.evaluate(()=>window.electronAPI.openSettingsTab('intelligence'));
 const full=launcher.getByRole('combobox',{name:'Answer length',exact:true});await full.waitFor();assert.equal(await full.inputValue(),'auto');
 await full.selectOption('detailed');
 for(let i=0;i<60;i++){if(await launcher.evaluate(()=>window.electronAPI.getAnswerLength())==='detailed')break;await new Promise(r=>setTimeout(r,100));}
 assert.equal(await launcher.evaluate(()=>window.electronAPI.getAnswerLength()),'detailed');
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'settings.json'))).answerLength,'detailed');
 await full.scrollIntoViewIfNeeded();await launcher.screenshot({path:'.agent/answer-length-settings.png'});
 await launcher.evaluate(()=>window.electronAPI.toggleSettingsWindow({x:100,y:100}));
 let popup;for(let i=0;i<100;i++){popup=app.windows().find(p=>p.url().endsWith('window=settings'));if(popup)break;await new Promise(r=>setTimeout(r,200));}assert.ok(popup);
 const group=popup.getByRole('group',{name:'Answer length',exact:true});await group.waitFor();
 assert.equal(await popup.getByRole('combobox',{name:'Answer length',exact:true}).count(),0);
 const handle=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('window=settings')).getNativeWindowHandle().readBigUInt64LE().toString());
 const {execFileSync}=require('child_process');
 for(const [value,label] of [['brief','Brief'],['balanced','Balanced'],['detailed','Detailed'],['auto','Auto']]){
  const control=group.getByRole('button',{name:label,exact:true});
  await control.waitFor();const box=await control.boundingBox();const width=await popup.evaluate(()=>innerWidth);
  execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'helpers','click-popup-control.ps1'),'-WindowHandle',handle,'-CssX',String(box.x+box.width/2),'-CssY',String(box.y+box.height/2),'-CssWidth',String(width)],{windowsHide:true,encoding:'utf8'});
  for(let i=0;i<60;i++){if(await launcher.evaluate(()=>window.electronAPI.getAnswerLength())===value)break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(await launcher.evaluate(()=>window.electronAPI.getAnswerLength()),value);
  assert.equal(await full.inputValue(),value);
  assert.equal(await control.getAttribute('aria-pressed'),'true');
  await new Promise(r=>setTimeout(r,400));
  assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('window=settings')).isVisible()),true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'settings.json'))).answerLength,value);
 }
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'settings.json'))).outputStyle,voice);
 const dimensions=await popup.evaluate(()=>({width:document.documentElement.scrollWidth,viewport:innerWidth,height:document.querySelector('.overlay-popover-surface').getBoundingClientRect().height,viewportHeight:innerHeight}));
 assert.ok(dimensions.width<=dimensions.viewport);assert.ok(dimensions.height<=dimensions.viewportHeight+1);
 await popup.screenshot({path:'.agent/answer-length-buttons.png'});
 console.log(JSON.stringify({realWindowsMouseClicks:true,popupRemainsOpen:true,fullSettingsSave:true,quickSettingsSave:true,crossWindowSync:true,diskPersistence:true,outputStyleUnchanged:true,autoRestoresDefaults:true,popupFits:true}));
 }finally{await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
