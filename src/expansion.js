/* Fishing game expansion: progression, events, boss challenge and collection.
 * This file extends the original Quark game without replacing its core loop.
 */
(function(){
var ns = Q.use("fish"), game = ns.game;
var PLAYER_ID_KEY = "fishjoy_player_id_v1";
var playerId = getOrCreatePlayerId();
var KEY = "fishjoy_progress_v1_" + playerId;
var state = {coins:null, cannonLevel:1, rewardBoostUntil:0, catches:{}, achievements:{}, bossWins:0, challengeBossHp:0, eventCount:0, chainKills:0, chainCharges:0, screenClearCharges:0};
function getOrCreatePlayerId(){
 try {
  var id=localStorage.getItem(PLAYER_ID_KEY);
  if(!id){id="guest_"+Date.now().toString(36)+"_"+Math.random().toString(36).slice(2,12);localStorage.setItem(PLAYER_ID_KEY,id);}
  return id;
 } catch(e){return "guest_session";}
}
var overlay, statusNode, noticeNode, accountButton, onlineNode, leaderboardModal=null, tick=0, lastEvent=0, lastBoss=0, onlinePollTimer=null;
var originalCapture = null, originalUpdate = null, originalMakeFish = null, originalFire = null, originalUpdateCoin = null, originalBulletCheckCollision = null;
var clearSkillButton = null;
var weaponMode = 0, weaponButton = null;
var weaponNames = ["标准炮","连发炮","散射炮"];
var fishNames = ["小丑鱼","蓝色小鱼","金色鱼","蝴蝶鱼","狮子鱼","灯笼鱼","海龟","魔鬼鱼","珍珠鱼","深海鱼","黄金鲨鱼","巨齿鲨","霓虹鱼","深海金鱼","迅捷鱼"];
var originalSetType = ns.Fish.prototype.setType;
ns.Fish.prototype.setType = function(type){this.type=type;return originalSetType.call(this,type);};
var variantsAdded=false;
function addFishVariants(){
 if(variantsAdded||!ns.R.fishTypes)return;
 var defs=[{base:4,coin:18,rate:.32,group:5,speed:1.35},{base:8,coin:75,rate:.16,group:2,speed:.72},{base:10,coin:90,rate:.12,group:2,speed:1.05}];
 for(var i=0;i<defs.length;i++){var d=defs[i],base=ns.R.fishTypes[d.base],mix={};for(var k in base.mixin)mix[k]=base.mixin[k];mix.coin=d.coin;mix.captureRate=d.rate;mix.maxNumGroup=d.group;mix.minSpeed=d.speed*.75;mix.maxSpeed=d.speed*1.25;ns.R.fishTypes.push({image:base.image,frames:base.frames,polyArea:base.polyArea,mixin:mix});}
 variantsAdded=true;
}
function loadState(){
 try {
  var raw=localStorage.getItem(KEY);
  // Migrate the old browser-wide save into this browser's new guest profile once.
  if(!raw){raw=localStorage.getItem("fishjoy_progress_v1");}
  var saved=JSON.parse(raw||"{}");
  if(saved && typeof saved==="object") {
   state.coins=(saved.coins!==undefined&&isFinite(Number(saved.coins)))?Math.max(0,Number(saved.coins)):null;
   state.cannonLevel=Math.max(1,Math.min(7,Number(saved.cannonLevel)||1));
   state.catches=saved.catches||{}; state.achievements=saved.achievements||{}; state.bossWins=Number(saved.bossWins)||0; state.challengeBossHp=Math.max(0,Math.min(12,Number(saved.challengeBossHp)||0)); state.eventCount=Number(saved.eventCount)||0; state.chainKills=Math.max(0,Math.min(14,Number(saved.chainKills)||0)); state.chainCharges=Math.max(0,Math.min(99,Number(saved.chainCharges)||0)); state.screenClearCharges=Math.max(0,Math.min(3,Number(saved.screenClearCharges)||0));
  }
 } catch(e){}
}
var cloudUser=null, cloudReady=false, cloudSaveTimer=null, cloudSaveDirty=false, cloudSaveInFlight=false, cloudSaveVersion=0, lastCloudSyncNoticeAt=0, accountModal=null, accountMode="login";
function exportSave(){
 var copy={};
 for(var k in state)copy[k]=state[k];
 if(game.player)copy.coins=game.player.coin;
 return copy;
}
function exportGuestSave(){
 try {
  var guest=JSON.parse(localStorage.getItem(KEY)||"null");
  if(guest&&typeof guest==="object")return guest;
 } catch(e){}
 return exportSave();
}
function restoreGuestSave(){
 cloudUser=null;cloudReady=true;updateOnlineCount();
 loadState();
 if(game.player&&state.coins!==null)game.player.updateCoin(state.coins,false);
 if(game.player&&game.player.cannon)game.player.cannon.setPower(state.cannonLevel,false);
 saveState();refresh();setAccountLabel();
}
function flushCloudSave(useKeepalive){
  if(!cloudUser||!cloudReady||!cloudSaveDirty||cloudSaveInFlight)return;
  if(cloudSaveTimer){clearTimeout(cloudSaveTimer);cloudSaveTimer=null;}
  var version=cloudSaveVersion;
  var payload=JSON.stringify({save:exportSave()});
  var uploadSucceeded=false;
  cloudSaveInFlight=true;
  fetch("/api/save",{method:"PUT",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:payload,keepalive:!!useKeepalive})
   .then(function(r){return r.json().catch(function(){return {};}).then(function(data){
    if(!r.ok){
     var msg=data.error||("HTTP "+r.status);
     if(data.code)msg+="；定位代码："+data.code;
     if(data.traceId)msg+="；编号："+data.traceId;
     if(data.diagnostic){
      if(data.diagnostic.receivedOrigin)msg+="；网页来源："+data.diagnostic.receivedOrigin+"；API来源："+data.diagnostic.apiOrigin+"；Host："+data.diagnostic.host;
      else if(data.diagnostic.message)msg+="；底层错误："+data.diagnostic.name+"："+data.diagnostic.message;
     }
     throw new Error(msg);
    }
    if(cloudSaveVersion===version)cloudSaveDirty=false;
    uploadSucceeded=true;
    if(!useKeepalive)cloudSyncNotice("云端存档同步成功");
   });})
   .catch(function(err){if(!useKeepalive)cloudSyncNotice("云端同步失败："+err.message);})
   .finally(function(){
    cloudSaveInFlight=false;
    if(cloudSaveDirty&&uploadSucceeded&&!useKeepalive)scheduleCloudSave();
   });
 }
 function scheduleCloudSave(){
  if(!cloudUser||!cloudReady)return;
  cloudSaveDirty=true;cloudSaveVersion++;
  if(cloudSaveTimer)clearTimeout(cloudSaveTimer);
  cloudSaveTimer=setTimeout(function(){cloudSaveTimer=null;flushCloudSave(false);},500);
 }
 // Retry dirty data periodically, even if no new gameplay event occurs.
 window.setInterval(function(){if(cloudSaveDirty)flushCloudSave(false);},15000);
 // Best-effort final upload when the page is backgrounded or closed.
 document.addEventListener("visibilitychange",function(){if(document.visibilityState==="hidden")flushCloudSave(true);});
 window.addEventListener("pagehide",function(){flushCloudSave(true);});
function saveState(){
 try {
  if(game.player)state.coins=game.player.coin;
  localStorage.setItem(cloudUser?("fishjoy_account_cache_"+cloudUser.id):KEY,JSON.stringify(state));
  scheduleCloudSave();
 } catch(e){}
}
function apiRequest(path,body){
 var controller=typeof AbortController!=="undefined"?new AbortController():null;
 var timeout=window.setTimeout(function(){if(controller)controller.abort();},20000);
 return fetch(path,{method:body?"POST":"GET",credentials:"same-origin",headers:body?{"Content-Type":"application/json"}:{},body:body?JSON.stringify(body):undefined,signal:controller?controller.signal:undefined})
  .then(function(r){return r.json().then(function(data){
   if(!r.ok){
    var detail=data.code?"（定位代码："+data.code+(data.traceId?"；编号："+data.traceId:"")+"）":"";
    var diagnostic="";
    if(data.diagnostic){
     if(data.diagnostic.name) diagnostic="\n底层错误："+data.diagnostic.name+"："+data.diagnostic.message;
     else diagnostic="\n网页来源："+data.diagnostic.receivedOrigin+"\nAPI来源："+data.diagnostic.apiOrigin+"\n服务器Host："+data.diagnostic.host;
    }
    throw new Error((data.error||"请求失败")+detail+diagnostic);
   }
   return data;
  });})
  .catch(function(err){
   if(err&&err.name==="AbortError")throw new Error("请求超时（20秒）。请检查网络或 Cloudflare Worker 日志后重试。");
   throw err;
  })
  .finally(function(){window.clearTimeout(timeout);});
}
function applyCloudSave(saved){
 if(!saved||typeof saved!=="object")return;
 state.coins=(saved.coins!==undefined&&isFinite(Number(saved.coins)))?Math.max(0,Number(saved.coins)):state.coins;
 state.cannonLevel=Math.max(1,Math.min(7,Number(saved.cannonLevel)||1));
 state.catches=saved.catches||{};state.achievements=saved.achievements||{};
 state.bossWins=Number(saved.bossWins)||0;state.challengeBossHp=Math.max(0,Math.min(12,Number(saved.challengeBossHp)||0));state.eventCount=Number(saved.eventCount)||0;state.chainKills=Math.max(0,Math.min(14,Number(saved.chainKills)||0));state.chainCharges=Math.max(0,Math.min(99,Number(saved.chainCharges)||0));state.screenClearCharges=Math.max(0,Math.min(3,Number(saved.screenClearCharges)||0));
 if(game.player&&state.coins!==null)game.player.updateCoin(state.coins,false);
 if(game.player&&game.player.cannon)game.player.cannon.setPower(state.cannonLevel,false);
 saveState();refresh();
}
function setAccountLabel(){
 if(accountButton)accountButton.textContent=cloudUser?"账号："+cloudUser.username:"账号/云存档";
}
function updateOnlineCount(){
 apiRequest("/api/online-count").then(function(data){
  if(onlineNode)onlineNode.textContent="在线人数 "+(Number(data.onlineCount)||0);
 }).catch(function(){if(onlineNode)onlineNode.textContent="在线人数 --";});
}
function sendHeartbeat(){
 if(!cloudUser){updateOnlineCount();return;}
 apiRequest("/api/heartbeat",{}).then(function(data){
  if(onlineNode)onlineNode.textContent="在线人数 "+(Number(data.onlineCount)||0);
 }).catch(function(){updateOnlineCount();});
}
function showLeaderboard(){
 if(leaderboardModal){if(leaderboardModal.parentNode)leaderboardModal.parentNode.removeChild(leaderboardModal);leaderboardModal=null;return;}
 leaderboardModal=document.createElement("div");
 leaderboardModal.style.cssText="position:fixed;inset:0;z-index:10002;background:rgba(0,0,0,.84);display:flex;align-items:center;justify-content:center;padding:16px;pointer-events:auto;font:15px Arial,sans-serif;color:#fff;";
 var panel=document.createElement("div");
 panel.style.cssText="width:min(390px,100%);max-height:82vh;overflow:auto;background:#082b3b;border:1px solid #e6b94c;border-radius:14px;padding:16px;box-shadow:0 8px 35px #000;";
 var heading=document.createElement("div");heading.textContent="金币排行榜 TOP 10";heading.style.cssText="font-size:20px;font-weight:bold;color:#ffd76a;text-align:center;margin-bottom:12px;";
 var list=document.createElement("div");list.style.cssText="display:flex;flex-direction:column;gap:7px;min-height:80px;";
 var status=document.createElement("div");status.textContent="正在读取排行榜...";status.style.cssText="text-align:center;color:#b9d9e4;padding:18px 4px;";
 var actions=document.createElement("div");actions.style.cssText="display:flex;gap:8px;margin-top:12px;";
 var reload=makeButton("刷新",loadRows);reload.style.flex="1";
 var close=makeButton("关闭",function(){if(leaderboardModal&&leaderboardModal.parentNode)leaderboardModal.parentNode.removeChild(leaderboardModal);leaderboardModal=null;});close.style.flex="1";
 actions.appendChild(reload);actions.appendChild(close);
 panel.appendChild(heading);panel.appendChild(status);panel.appendChild(list);panel.appendChild(actions);leaderboardModal.appendChild(panel);document.body.appendChild(leaderboardModal);
 function loadRows(){
  status.textContent="正在读取排行榜...";list.textContent="";
  apiRequest("/api/leaderboard").then(function(data){
   status.textContent=data.entries&&data.entries.length?"按当前云端金币排序":"暂无排行榜数据";
   (data.entries||[]).slice(0,10).forEach(function(entry,index){
    var row=document.createElement("div");row.style.cssText="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 11px;border-radius:8px;background:rgba(255,255,255,.08);";
    var name=document.createElement("span");name.textContent=(index+1)+". "+entry.username;name.style.cssText="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    var coins=document.createElement("b");coins.textContent=(Number(entry.coins)||0).toLocaleString()+" 金币";coins.style.cssText="color:#ffd76a;white-space:nowrap;";
    if(index===0)name.style.color="#ffd76a";else if(index===1)name.style.color="#d9e5ed";else if(index===2)name.style.color="#e7a77c";
    row.appendChild(name);row.appendChild(coins);list.appendChild(row);
   });
  }).catch(function(err){status.textContent="排行榜读取失败："+err.message;});
 }
 loadRows();
}
function closeAccountModal(){
 if(accountModal&&accountModal.parentNode)accountModal.parentNode.removeChild(accountModal);
 accountModal=null;
}
function showAccountModal(){
 if(accountModal){closeAccountModal();return;}
 accountMode="login";
 accountModal=document.createElement("div");
 accountModal.style.cssText="position:fixed;inset:0;z-index:10001;background:rgba(0,0,0,.82);display:flex;align-items:center;justify-content:center;padding:18px;pointer-events:auto;font:15px Arial,sans-serif;color:#fff;";
 var panel=document.createElement("div");
 panel.style.cssText="width:min(360px,100%);max-height:85vh;overflow:auto;background:#082b3b;border:1px solid #69cce8;border-radius:14px;padding:18px;box-shadow:0 8px 35px #000;";
 var heading=document.createElement("div");heading.textContent="捕鱼游戏账号";heading.style.cssText="font-size:20px;font-weight:bold;margin-bottom:12px;text-align:center;";
 var tabs=document.createElement("div");tabs.style.cssText="display:flex;gap:8px;margin-bottom:14px;";
 var loginTab=makeButton("登录",function(){accountMode="login";render();});
 var registerTab=makeButton("注册账号",function(){accountMode="register";render();});
 tabs.appendChild(loginTab);tabs.appendChild(registerTab);
 var form=document.createElement("form");form.style.cssText="display:flex;flex-direction:column;gap:10px;";
 var nameLabel=document.createElement("label");nameLabel.textContent="游戏昵称";
 var nameInput=document.createElement("input");nameInput.autocomplete="username";nameInput.maxLength=20;nameInput.required=true;nameInput.placeholder="3-20位昵称";nameInput.style.cssText="padding:12px;border-radius:8px;border:1px solid #6ba9bd;font-size:16px;width:100%;";
 var passLabel=document.createElement("label");passLabel.textContent="密码";
 var passInput=document.createElement("input");passInput.type="password";passInput.autocomplete="current-password";passInput.minLength=8;passInput.maxLength=72;passInput.required=true;passInput.placeholder="至少8位";passInput.style.cssText=nameInput.style.cssText;
 var hint=document.createElement("div");hint.style.cssText="font-size:12px;color:#b9d9e4;line-height:1.5;";
 var error=document.createElement("div");error.style.cssText="color:#ffb1a8;font-size:13px;min-height:18px;";
 var submit=document.createElement("button");submit.type="submit";submit.style.cssText="padding:12px;border:0;border-radius:8px;background:#1598bd;color:white;font-size:16px;font-weight:bold;";
 var close=makeButton("关闭",closeAccountModal);close.style.marginTop="10px";close.style.width="100%";
 nameLabel.appendChild(nameInput);passLabel.appendChild(passInput);
 form.appendChild(nameLabel);form.appendChild(nameInput);form.appendChild(passLabel);form.appendChild(passInput);form.appendChild(hint);form.appendChild(error);form.appendChild(submit);
 panel.appendChild(heading);panel.appendChild(tabs);panel.appendChild(form);
 if(cloudUser){var who=document.createElement("div");who.textContent="当前已登录："+cloudUser.username;who.style.cssText="text-align:center;margin:8px 0;color:#b9e9ff;";panel.appendChild(who);var logout=makeButton("退出登录",function(){apiRequest("/api/logout",{}).then(function(){restoreGuestSave();closeAccountModal();notice("已退出账号，当前设备继续使用游客存档");}).catch(function(e){error.textContent=e.message;});});logout.style.width="100%";panel.appendChild(logout);
  var deleteButton=makeButton("注销账号",function(){deletePanel.style.display=deletePanel.style.display==="none"?"block":"none";});
  deleteButton.style.cssText+="width:100%;margin-top:8px;border-color:#ff8d82;color:#ffd0ca;";
  panel.appendChild(deleteButton);
  var deletePanel=document.createElement("div");
  deletePanel.style.cssText="display:none;margin-top:10px;padding:12px;border:1px solid #b85b54;border-radius:9px;background:rgba(80,15,15,.35);";
  var deleteWarning=document.createElement("div");
  deleteWarning.textContent="危险操作：注销后账号资料、云端存档和所有登录会话将被永久删除，无法恢复。请输入当前账号密码进行验证。";
  deleteWarning.style.cssText="font-size:12px;line-height:1.6;color:#ffd0ca;margin-bottom:9px;";
  var deletePassword=document.createElement("input");
  deletePassword.type="password";deletePassword.autocomplete="current-password";deletePassword.maxLength=72;deletePassword.placeholder="输入当前账号密码";
  deletePassword.style.cssText="box-sizing:border-box;width:100%;padding:11px;border-radius:7px;border:1px solid #b85b54;font-size:16px;margin-bottom:8px;";
  var deleteError=document.createElement("div");
  deleteError.style.cssText="color:#ffb1a8;font-size:12px;min-height:16px;margin-bottom:6px;";
  var confirmDelete=makeButton("验证密码并永久注销",function(){
   var password=deletePassword.value;
   if(!password){deleteError.textContent="请先输入账号密码";return;}
   if(!window.confirm("确定永久注销账号“"+cloudUser.username+"”吗？账号和云端存档删除后无法恢复。"))return;
   confirmDelete.disabled=true;deleteError.textContent="正在验证密码并注销...";
   apiRequest("/api/delete-account",{password:password}).then(function(){
    try{localStorage.removeItem("fishjoy_account_cache_"+cloudUser.id);}catch(e){}
    deletePassword.value="";
    restoreGuestSave();closeAccountModal();
    notice("账号已注销，已切换到游客模式");
   }).catch(function(err){
    deleteError.textContent=err.message;confirmDelete.disabled=false;
   });
  });
  confirmDelete.style.cssText+="width:100%;background:#a83232;border-color:#ff9c91;";
  deletePanel.appendChild(deleteWarning);deletePanel.appendChild(deletePassword);deletePanel.appendChild(deleteError);deletePanel.appendChild(confirmDelete);
  panel.appendChild(deletePanel);
}
 panel.appendChild(close);accountModal.appendChild(panel);document.body.appendChild(accountModal);
 function render(){
  loginTab.style.opacity=accountMode==="login"?"1":".55";registerTab.style.opacity=accountMode==="register"?"1":".55";
  passInput.autocomplete=accountMode==="register"?"new-password":"current-password";
  submit.textContent=accountMode==="register"?"注册并迁移游客存档":"登录";
  hint.textContent=accountMode==="register"?"注册成功后，本设备的游客金币、炮台等级、图鉴和成就会自动迁移到账号。昵称不可重复，密码至少8位。":"登录后将读取该账号的云端游戏进度。";
  error.textContent="";
 }
 form.addEventListener("submit",function(e){
  e.preventDefault();error.textContent="正在处理...";
  if(accountMode==="register"&&cloudUser){error.textContent="请先退出当前账号，再注册新账号";return;}
  var payload={username:nameInput.value,password:passInput.value};
  var action=accountMode==="register"?apiRequest("/api/register",{username:payload.username,password:payload.password,guestSave:exportGuestSave()}):apiRequest("/api/login",payload);
  action.then(function(result){
   cloudUser=result.user;setAccountLabel();sendHeartbeat();
   if(accountMode==="register"){
    cloudReady=true;applyCloudSave(result.save);lastCloudSyncNoticeAt=Date.now();notice("注册成功！游客存档已迁移到账号");
   }else{
    // Authentication is successful as soon as /api/login returns.
    // Do not keep the login form stuck on "正在处理..." while cloud save loads.
    cloudReady=false;
    closeAccountModal();
    lastCloudSyncNoticeAt=Date.now();
    notice("登录成功，正在读取云存档...");
    apiRequest("/api/save").then(function(remote){
     if(remote.save)applyCloudSave(remote.save);
     else {cloudReady=true;saveState();}
     cloudReady=true;setAccountLabel();
    }).catch(function(err){
     cloudReady=true;setAccountLabel();
     cloudSyncNotice("登录成功，但云存档读取失败："+err.message);
    });
    return;
   }
   closeAccountModal();
  }).catch(function(err){error.textContent=err.message;});
 });
 render();
}
function restoreCloudSession(){
 apiRequest("/api/me").then(function(result){
  cloudUser=result.user;setAccountLabel();sendHeartbeat();cloudReady=false;
  return apiRequest("/api/save");
 }).then(function(result){
  if(result.save)applyCloudSave(result.save);
  cloudReady=true;setAccountLabel();
 }).catch(function(){cloudUser=null;cloudReady=true;setAccountLabel();});
}
function notice(msg){ if(!noticeNode)return; var specialEvent=/特殊事件：|金币潮汐|鱼群风暴|珍稀鱼群/i.test(msg); var goldNotice=specialEvent||/BOSS来袭|大量鱼群|击杀BOSS|BOSS挑战成功|BOSS被击败/i.test(msg); noticeNode.textContent=specialEvent&&!/[！!]{3}$/.test(msg)?msg+"！！！":msg; noticeNode.style.color=goldNotice?"#ffd700":"#fff"; noticeNode.style.textShadow=goldNotice?"0 0 6px rgba(255,215,0,.65)":"0 1px 3px #000"; noticeNode.style.opacity="1"; window.clearTimeout(noticeNode._timer); noticeNode._timer=window.setTimeout(function(){noticeNode.style.opacity="0";},2600); }
 function cloudSyncNotice(msg){var now=Date.now();if(!lastCloudSyncNoticeAt||now-lastCloudSyncNoticeAt>=120000){lastCloudSyncNoticeAt=now;notice(msg);}}
function makeButton(label, action){
 var b=document.createElement("button"); b.type="button"; b.textContent=label;
 b.style.cssText="border:1px solid #8bd8ee;background:rgba(3,45,67,.9);color:#fff;border-radius:8px;padding:7px 10px;font-size:13px;font-weight:bold;touch-action:manipulation;";
 b.addEventListener("click",function(e){e.preventDefault();e.stopPropagation();action();}); return b;
}
function refresh(){
 if(!statusNode)return;
 var gold=game.player?game.player.coin:0;
 statusNode.innerHTML='<span class="stat-coin">金币 <b>'+gold+'</b></span><span class="stat-cannon">炮台 <b>'+state.cannonLevel+'/7</b></span><span class="stat-boss">BOSS <b>'+state.bossWins+'胜</b></span><span class="stat-chain">连锁 <b>'+(state.chainCharges>0?"已充能×"+state.chainCharges:state.chainKills+"/15")+'</b></span>';
 if(clearSkillButton){clearSkillButton.textContent="全屏清理 ×"+state.screenClearCharges;clearSkillButton.disabled=state.screenClearCharges<=0;clearSkillButton.style.opacity=state.screenClearCharges>0?"1":".55";}
 if(onlineNode){if(!onlineNode.textContent)onlineNode.textContent="在线人数 --";statusNode.appendChild(onlineNode);}
}
function updateAchievements(){
 var total=0; Object.keys(state.catches).forEach(function(k){total+=state.catches[k]||0;});
 if(total>=1) state.achievements.firstCatch=true;
 if(total>=50) state.achievements.fisher50=true;
 if(total>=200) state.achievements.fisher200=true;
 if(state.bossWins>=1) state.achievements.boss1=true;
 saveState();
}
function addProgressUI(){
 if(document.getElementById("fishjoy-expansion"))return;
 var style=document.createElement("style");
 style.textContent="#fishjoy-expansion{position:fixed;z-index:9999;left:8px;right:8px;top:8px;display:flex;flex-direction:column;gap:6px;pointer-events:none;font:13px Arial,sans-serif;color:#fff;text-shadow:0 1px 3px #000}#fishjoy-expansion .bar{display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;pointer-events:none}#fishjoy-expansion .controls{display:flex;gap:6px;flex-wrap:wrap;pointer-events:auto}#fishjoy-expansion .notice{align-self:center;background:rgba(0,0,0,.72);border:1px solid #8bd8ee;border-radius:12px;padding:8px 14px;opacity:0;transition:opacity .2s;pointer-events:none}#fishjoy-expansion button{min-height:34px}#fishjoy-expansion .stats{display:flex;align-items:center;gap:6px;flex-wrap:wrap}#fishjoy-expansion .stats span{display:inline-block;padding:5px 8px;border-radius:7px;font-weight:bold;text-shadow:none}#fishjoy-expansion .stat-coin{background:linear-gradient(135deg,#ffe78a,#e6a817);color:#241800;border:1px solid #fff0ad}#fishjoy-expansion .stat-coin b{color:#241800}#fishjoy-expansion .stat-cannon{background:rgba(0,145,210,.88);color:#e8f8ff;border:1px solid #65d5ff}#fishjoy-expansion .stat-boss{background:rgba(132,65,190,.9);color:#fff0ff;border:1px solid #d4a2ff}#fishjoy-expansion .stat-chain{background:rgba(180,75,20,.92);color:#fff4e8;border:1px solid #ffc078}#fishjoy-expansion button.btn-cannon{background:linear-gradient(135deg,#087eb8,#07517f);border-color:#5bcaff;color:#fff}#fishjoy-expansion button.btn-skill{background:linear-gradient(135deg,#168b55,#075c3b);border-color:#62e6a0;color:#effff5}#fishjoy-expansion button.btn-achievement{background:linear-gradient(135deg,#8151b5,#512d83);border-color:#d0a6ff;color:#fff}#fishjoy-expansion button.btn-boss{background:linear-gradient(135deg,#b83e38,#76201e);border-color:#ff9b8f;color:#fff}";
 document.head.appendChild(style);
 overlay=document.createElement("div"); overlay.id="fishjoy-expansion";
 var bar=document.createElement("div");bar.className="bar";
 statusNode=document.createElement("div");statusNode.className="stats";statusNode.style.cssText="padding:2px 0;border-radius:8px;";
 onlineNode=document.createElement("span");onlineNode.className="stat-online";onlineNode.textContent="在线人数 --";onlineNode.style.cssText="background:rgba(12,105,70,.92);color:#eafff3;border:1px solid #65d99b;padding:5px 8px;border-radius:7px;font-weight:bold;text-shadow:none;";statusNode.appendChild(onlineNode);
 var controls=document.createElement("div");controls.className="controls";
 weaponButton=makeButton("武器："+weaponNames[weaponMode],cycleWeapon);controls.appendChild(weaponButton);
 var cannonButton=makeButton("升级炮台",upgradeCannon);cannonButton.className="btn-cannon";controls.appendChild(cannonButton);
 var skillButton=makeButton("金币技能",activateBoost);skillButton.className="btn-skill";controls.appendChild(skillButton);
 var bossButton=makeButton("BOSS挑战",spawnBoss);bossButton.className="btn-boss";controls.appendChild(bossButton);
 var achievementButton=makeButton("图鉴/成就",showDex);achievementButton.className="btn-achievement";controls.appendChild(achievementButton);
 var leaderboardButton=makeButton("金币榜 TOP10",showLeaderboard);leaderboardButton.style.cssText+="background:linear-gradient(135deg,#a87918,#69450b);border-color:#ffdc78;color:#fff7d6;";controls.appendChild(leaderboardButton);
 accountButton=makeButton("账号/云存档",showAccountModal);controls.appendChild(accountButton);
 bar.appendChild(statusNode);bar.appendChild(controls);
 noticeNode=document.createElement("div");noticeNode.className="notice";
 overlay.appendChild(bar);overlay.appendChild(noticeNode);document.body.appendChild(overlay);
 clearSkillButton=makeButton("全屏清理 ×0",activateScreenClear);clearSkillButton.id="fishjoy-screen-clear";clearSkillButton.style.cssText+="position:fixed;z-index:10001;left:calc(50% + 58px);bottom:calc(22px + env(safe-area-inset-bottom));min-height:42px;padding:8px 12px;background:linear-gradient(135deg,#a52bca,#5a218e);border:2px solid #e4a7ff;border-radius:12px;color:#fff;font-size:14px;box-shadow:0 0 12px rgba(190,90,255,.55);";document.body.appendChild(clearSkillButton);
 refresh();updateOnlineCount();
 if(!onlinePollTimer)onlinePollTimer=window.setInterval(sendHeartbeat,15000);
}
function activateScreenClear(){
 if(state.screenClearCharges<=0){notice("全屏清理技能次数不足");return;}
 if(!game.fishManager||!game.fishManager.fishes)return;
 state.screenClearCharges--;var cleared=0,fishes=game.fishManager.fishes.slice();
 for(var i=0;i<fishes.length;i++){var fish=fishes[i];if(!fish||fish.captured||fish.boss)continue;fish.moving=false;fish.captured=true;fish.capturingCounter=game.fps>>1;fish.gotoAndPlay("capture");cleared++;}
 saveState();refresh();notice("全屏清理发动！清除了 "+cleared+" 条鱼");
}
function cycleWeapon(){
 weaponMode=(weaponMode+1)%weaponNames.length; if(weaponButton)weaponButton.textContent="武器："+weaponNames[weaponMode];
 game.fireInterval=weaponMode===1?Math.max(7,Math.floor(game.fps*.18)):Math.floor(game.fps*.5);
 notice("已切换："+weaponNames[weaponMode]+(weaponMode===2?"（三发散射，消耗三倍金币）":""));
}
function upgradeCannon(){
 if(!game.player)return;
 var next=state.cannonLevel+1, cost=next*250;
 if(next>7){notice("炮台已升至最高等级");return;}
 if(game.player.coin<cost){notice("升级需要 "+cost+" 金币");return;}
 game.player.updateCoin(-cost,true); state.cannonLevel=next;
 game.player.cannon.setPower(next,false);saveState();refresh();notice("炮台升级成功：等级 "+next);
}
function activateBoost(){
 if(!game.player)return;
 if(game.player.coin<100){notice("金币不足，技能需要100金币");return;}
 game.player.updateCoin(-100,true);state.rewardBoostUntil=Date.now()+30000;refresh();notice("金币加成已启动：30秒内捕获奖励翻倍");
}
function showDex(){
 var total=0, rows=[];
 for(var i=0;i<fishNames.length;i++){var n=state.catches[i+1]||0;total+=n;rows.push(fishNames[i]+"："+n+"次");}
 var ach=[];
 if(state.achievements.firstCatch)ach.push("初次捕获");
 if(state.achievements.fisher50)ach.push("捕鱼新手（50条）");
 if(state.achievements.fisher200)ach.push("捕鱼达人（200条）");
 if(state.achievements.boss1)ach.push("BOSS猎手");
 window.alert("鱼类图鉴（累计 "+total+" 条）\n"+rows.join("\n")+"\n\n成就：\n"+(ach.join("、")||"尚未解锁成就"));
}
function spawnBoss(){
 if(!game.stage||!game.fishManager)return;
 var type=ns.R.fishTypes[12]||ns.R.fishTypes[11];
 var boss=new ns.Fish(type); boss.setType(type); boss.id="challengeBoss_"+Date.now();
 boss.scaleX=boss.scaleY=Math.min(.62,Math.max(.38,game.width/850));
 boss.x=game.width*.5; boss.y=game.height*.42; boss.speed=.22; boss.setDirection(0);
 boss.coin=500;boss.captureRate=1;boss.bossHp=state.challengeBossHp>0?state.challengeBossHp:12;boss.bossMaxHp=12;boss.boss=true;boss.canTurning=false;state.challengeBossHp=boss.bossHp;saveState();
 boss.canBeCaptured=function(){this.bossHp--;state.challengeBossHp=Math.max(0,this.bossHp);saveState();notice("BOSS受到攻击："+Math.max(0,this.bossHp)+"/"+this.bossMaxHp);if(this.bossHp<=0){state.challengeBossHp=0;state.bossWins++;saveState();updateAchievements();notice("BOSS挑战成功！奖励500金币");return true;}return false;};
 game.fishManager.fishes.push(boss);game.fishContainer.addChild(boss);lastBoss=tick;
 notice("深海BOSS来袭！连续命中12次即可击败");
}
function triggerEvent(){
 if(!game.fishManager)return;
 state.eventCount++;saveState();
 var kind=state.eventCount%3;
 if(kind===0){state.rewardBoostUntil=Date.now()+15000;notice("特殊事件：金币潮汐！15秒捕获奖励翻倍");}
 else if(kind===1){for(var i=0;i<4;i++)game.fishManager.makeFish();notice("特殊事件：鱼群风暴！大量鱼群出现");}
 else {for(var j=0;j<3;j++)game.fishManager.makeFish();notice("特殊事件：珍稀鱼群！快来捕获");}
}
function resizeGame(){
 if(!game.stage||!game.container)return;
 var w=Math.max(320,Math.round(window.visualViewport?window.visualViewport.width:window.innerWidth));
 var h=Math.max(320,Math.round(window.visualViewport?window.visualViewport.height:window.innerHeight));

 game.width=w;game.height=h;game.screenWidth=w;game.screenHeight=h;
 game.container.style.width=w+"px";game.container.style.height=h+"px";
 game.stage.width=w;game.stage.height=h;
 if(game.context&&game.context.canvas&&game.context.canvas.tagName==="CANVAS"){game.context.canvas.width=w;game.context.canvas.height=h;}
 if(game.bg){game.bg.scaleX=w/game.bg.width;game.bg.scaleY=h/game.bg.height;}
 if(game.fishContainer){game.fishContainer.width=w;game.fishContainer.height=h;}
 var bottomLift=Math.min(36,Math.max(22,Math.round(h*0.045)));
 if(game.bottom){game.bottom.scaleX=Math.min(1,w/765);game.bottom.scaleY=game.bottom.scaleX;game.bottom.x=(w-game.bottom.width*game.bottom.scaleX)>>1;game.bottom.y=h-game.bottom.height*game.bottom.scaleY+2-bottomLift;}
 if(game.player){
  var p=game.player, bar=game.bottom;
  var originalBarY=h-bar.height*bar.scaleY+2;
  p.cannon.x=w*.5;p.cannon.y=h-10;
  p.cannonMinus.x=bar.x+bar.width*bar.scaleX*.445;p.cannonMinus.y=originalBarY+bar.height*bar.scaleY*.5;
  p.cannonPlus.x=p.cannonMinus.x+Math.min(140*bar.scaleX,w*.28);p.cannonPlus.y=p.cannonMinus.y;
  p.coinNum.x=bar.x+20*bar.scaleX;p.coinNum.y=bar.y+bar.height*bar.scaleY*.61;
 }
 if(game.stage.updatePosition)game.stage.updatePosition();
}
function triggerChainBlast(x,y,power){
 if(!game.fishManager||!game.fishManager.fishes)return;
 var radius=Math.max(135,Math.min(220,game.width*.22)),r2=radius*radius,hit=0,fishes=game.fishManager.fishes.slice();
 for(var i=0;i<fishes.length;i++){
  var fish=fishes[i];if(!fish||fish.captured||fish.boss)continue;
  var dx=fish.x-x,dy=fish.y-y;if(dx*dx+dy*dy>r2)continue;
  if(fish.canBeCaptured(power-1)){fish.moving=false;fish.captured=true;fish.capturingCounter=game.fps>>1;fish.gotoAndPlay("capture");hit++;}
 }
 try{var effect=new Q.Bitmap(ns.R.webs[Math.max(0,Math.min(6,power-1))]);effect.x=x;effect.y=y;effect.scaleX=effect.scaleY=.85;effect.alpha=.85;game.stage.addChild(effect);Q.Tween.to(effect,{scaleX:2.2,scaleY:2.2,alpha:0},{time:360,onComplete:function(){if(effect.parent)effect.parent.removeChild(effect);}});}catch(e){}
 notice("连锁爆炸！范围命中 "+hit+" 条鱼");
}
function init(){
 loadState();addFishVariants();addProgressUI();resizeGame();
 if(game.player){
  if(state.coins!==null)game.player.updateCoin(state.coins,false);
  else {state.coins=game.player.coin;saveState();}
  if(!originalUpdateCoin){originalUpdateCoin=game.player.updateCoin;game.player.updateCoin=function(coin,increase){
   originalUpdateCoin.call(this,coin,increase);
   state.coins=this.coin;saveState();
  };}
  game.player.cannon.setPower(state.cannonLevel,false);
  restoreCloudSession();
  if(!originalFire){originalFire=game.player.fire;game.player.fire=function(point){
   if(weaponMode!==2){return originalFire.call(this,point);}
   var spread=game.width*.055;originalFire.call(this,point);
   if(this.coin>=(this.cannon.power===7?10:Math.ceil(this.cannon.power*1.25))*2){originalFire.call(this,{x:point.x-spread,y:point.y});originalFire.call(this,{x:point.x+spread,y:point.y});}
  };}
 }
 if(!originalBulletCheckCollision&&ns.Bullet&&ns.Bullet.prototype){originalBulletCheckCollision=ns.Bullet.prototype.checkCollision;ns.Bullet.prototype.checkCollision=function(){var x=this.x,y=this.y,power=this.power,hit=originalBulletCheckCollision.apply(this,arguments);if(hit&&state.chainCharges>0){state.chainCharges--;saveState();triggerChainBlast(x,y,power);refresh();}return hit;};}
 if(!originalCapture){originalCapture=game.player.captureFish;game.player.captureFish=function(fish){
  var value=fish.coin;
  if(Date.now()<state.rewardBoostUntil)fish.coin=value*2;
  originalCapture.call(this,fish);
  fish.coin=value;
  var index=ns.R.fishTypes.indexOf(fish.type);if(index<1)index=1;
  state.catches[index]=(state.catches[index]||0)+1;
  state.chainKills++;if(state.chainKills>=15){state.chainKills=0;state.chainCharges=Math.min(99,state.chainCharges+1);notice("连锁效果已充能！当前 "+state.chainCharges+" 次，下一次命中触发范围爆炸");}
  if(state.screenClearCharges<3&&Math.random()<0.08){state.screenClearCharges++;notice("获得全屏清理技能！当前 "+state.screenClearCharges+"/3 次");}
  updateAchievements();saveState();refresh();
 };}
}
originalUpdate=game.update;
game.update=function(timeInfo){
 originalUpdate.call(this,timeInfo);
 tick++;
 if(!overlay&&this.player)init();
 if(tick-lastEvent>game.fps*45){lastEvent=tick;triggerEvent();}
 if(game.player&&tick%30===0)refresh();
};
game.resizeToViewport=resizeGame;
window.addEventListener("resize",resizeGame,false);
if(window.visualViewport)window.visualViewport.addEventListener("resize",resizeGame,false);
window.addEventListener("orientationchange",function(){setTimeout(resizeGame,250);},false);
})();
