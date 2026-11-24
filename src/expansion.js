/* Fishing game expansion: progression, events, boss challenge and collection.
 * This file extends the original Quark game without replacing its core loop.
 */
(function(){
var ns = Q.use("fish"), game = ns.game;
var KEY = "fishjoy_progress_v1";
var state = {coins:0, cannonLevel:1, rewardBoostUntil:0, catches:{}, achievements:{}, bossWins:0, eventCount:0};
var overlay, statusNode, noticeNode, tick=0, lastEvent=0, lastBoss=0;
var originalCapture = null, originalUpdate = null, originalMakeFish = null, originalFire = null;
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
 try { var saved=JSON.parse(localStorage.getItem(KEY)||"{}"); if(saved && typeof saved==="object") {
  state.coins=Number(saved.coins)||0; state.cannonLevel=Math.max(1,Math.min(7,Number(saved.cannonLevel)||1));
  state.catches=saved.catches||{}; state.achievements=saved.achievements||{}; state.bossWins=Number(saved.bossWins)||0; state.eventCount=Number(saved.eventCount)||0;
 }} catch(e){}
}
function saveState(){ try{localStorage.setItem(KEY,JSON.stringify(state));}catch(e){} }
function notice(msg){ if(!noticeNode)return; noticeNode.textContent=msg; noticeNode.style.opacity="1"; window.clearTimeout(noticeNode._timer); noticeNode._timer=window.setTimeout(function(){noticeNode.style.opacity="0";},2600); }
function makeButton(label, action){
 var b=document.createElement("button"); b.type="button"; b.textContent=label;
 b.style.cssText="border:1px solid #8bd8ee;background:rgba(3,45,67,.9);color:#fff;border-radius:8px;padding:7px 10px;font-size:13px;font-weight:bold;touch-action:manipulation;";
 b.addEventListener("click",function(e){e.preventDefault();e.stopPropagation();action();}); return b;
}
function refresh(){
 if(!statusNode)return;
 var gold=game.player?game.player.coin:0;
 statusNode.textContent="金币 "+gold+"  |  炮台 "+state.cannonLevel+"/7  |  BOSS "+state.bossWins+"胜";
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
 style.textContent="#fishjoy-expansion{position:fixed;z-index:9999;left:8px;right:8px;top:8px;display:flex;flex-direction:column;gap:6px;pointer-events:none;font:13px Arial,sans-serif;color:#fff;text-shadow:0 1px 3px #000}#fishjoy-expansion .bar{display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;pointer-events:none}#fishjoy-expansion .controls{display:flex;gap:6px;flex-wrap:wrap;pointer-events:auto}#fishjoy-expansion .notice{align-self:center;background:rgba(0,0,0,.72);border:1px solid #8bd8ee;border-radius:12px;padding:8px 14px;opacity:0;transition:opacity .2s;pointer-events:none}#fishjoy-expansion button{min-height:34px}";
 document.head.appendChild(style);
 overlay=document.createElement("div"); overlay.id="fishjoy-expansion";
 var bar=document.createElement("div");bar.className="bar";
 statusNode=document.createElement("div");statusNode.style.cssText="background:rgba(0,0,0,.48);padding:6px 9px;border-radius:8px;";
 var controls=document.createElement("div");controls.className="controls";
 weaponButton=makeButton("武器："+weaponNames[weaponMode],cycleWeapon);controls.appendChild(weaponButton);
 controls.appendChild(makeButton("升级炮台",upgradeCannon));
 controls.appendChild(makeButton("金币技能",activateBoost));
 controls.appendChild(makeButton("BOSS挑战",spawnBoss));
 controls.appendChild(makeButton("图鉴/成就",showDex));
 bar.appendChild(statusNode);bar.appendChild(controls);
 noticeNode=document.createElement("div");noticeNode.className="notice";
 overlay.appendChild(bar);overlay.appendChild(noticeNode);document.body.appendChild(overlay);
 refresh();
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
 boss.coin=500;boss.captureRate=1;boss.bossHp=12;boss.bossMaxHp=12;boss.boss=true;boss.canTurning=false;
 boss.canBeCaptured=function(){this.bossHp--;notice("BOSS受到攻击："+Math.max(0,this.bossHp)+"/"+this.bossMaxHp);if(this.bossHp<=0){state.bossWins++;saveState();updateAchievements();notice("BOSS挑战成功！奖励500金币");return true;}return false;};
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
 if(game.bottom){game.bottom.scaleX=Math.min(1,w/765);game.bottom.scaleY=game.bottom.scaleX;game.bottom.x=(w-game.bottom.width*game.bottom.scaleX)>>1;game.bottom.y=h-game.bottom.height*game.bottom.scaleY+2;}
 if(game.player){
  var p=game.player, bar=game.bottom;
  p.cannon.x=w*.5;p.cannon.y=h-10;
  p.cannonMinus.x=bar.x+bar.width*bar.scaleX*.445;p.cannonMinus.y=bar.y+bar.height*bar.scaleY*.5;
  p.cannonPlus.x=p.cannonMinus.x+Math.min(140*bar.scaleX,w*.28);p.cannonPlus.y=p.cannonMinus.y;
  p.coinNum.x=bar.x+20*bar.scaleX;p.coinNum.y=bar.y+bar.height*bar.scaleY*.61;
 }
 if(game.stage.updatePosition)game.stage.updatePosition();
}
function init(){
 loadState();addFishVariants();addProgressUI();resizeGame();
 if(game.player){
  game.player.cannon.setPower(state.cannonLevel,false);
  if(!originalFire){originalFire=game.player.fire;game.player.fire=function(point){
   if(weaponMode!==2){return originalFire.call(this,point);}
   var spread=game.width*.055;originalFire.call(this,point);
   if(this.coin>=this.cannon.power*2){originalFire.call(this,{x:point.x-spread,y:point.y});originalFire.call(this,{x:point.x+spread,y:point.y});}
  };}
 }
 if(!originalCapture){originalCapture=game.player.captureFish;game.player.captureFish=function(fish){
  var value=fish.coin;
  if(Date.now()<state.rewardBoostUntil)fish.coin=value*2;
  originalCapture.call(this,fish);
  fish.coin=value;
  var index=ns.R.fishTypes.indexOf(fish.type);if(index<1)index=1;
  state.catches[index]=(state.catches[index]||0)+1;updateAchievements();refresh();
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
