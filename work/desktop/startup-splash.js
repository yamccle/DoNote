/**
 * [INPUT]: 读取桌面启动消息、签名字形和当前主题。
 * [OUTPUT]: 实时绘制签名开场，并通知宿主恢复标题栏。
 * [POS]: 桌面开场控制器，负责运笔、光迹和退出。
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
'use strict';
{
 const host=location.origin==='https://yams-one.example'&&window.chrome?.webview;
 const duration=2540;
 const brushStart=90;
 const markWidth=1000;
 const markHeight=326;
 const sceneWidth=1140;
 const sceneHeight=460;

 function stroke(from,to,width,origin,...segments){
  const path=new Path2D();
  const points=[{x:origin[0],y:origin[1],length:0}];
  path.moveTo(...origin);
  for(const [ax,ay,bx,by,cx,cy] of segments){
   path.bezierCurveTo(ax,ay,bx,by,cx,cy);
   const start=points.at(-1);
   for(let n=1;n<=40;n++){
    const t=n/40;
    const u=1-t;
    const x=u*u*u*start.x+3*u*u*t*ax+3*u*t*t*bx+t*t*t*cx;
    const y=u*u*u*start.y+3*u*u*t*ay+3*u*t*t*by+t*t*t*cy;
    const previous=points.at(-1);
    points.push({x,y,length:previous.length+Math.hypot(x-previous.x,y-previous.y)});
   }
  }
  return {from,to,width,path,points,length:points.at(-1).length};
 }

 const clamp=value=>Math.min(1,Math.max(0,value));
 const smooth=value=>value*value*(3-2*value);
 const ease=value=>value+.12*Math.sin(Math.PI*value);
 const progress=(time,{from,to})=>ease(clamp((time-from)/(to-from)));

 function pointOn(line,distance){
  let low=0,high=line.points.length-1;
  while(high-low>1){
   const middle=(low+high)>>1;
   if(line.points[middle].length<distance)low=middle;
   else high=middle;
  }
  const a=line.points[low],b=line.points[high];
  const amount=clamp((distance-a.length)/(b.length-a.length||1));
  return {x:a.x+(b.x-a.x)*amount,y:a.y+(b.y-a.y)*amount};
 }

 function drawStroke(ctx,line,start,end){
  ctx.lineWidth=line.width;
  ctx.setLineDash([end-start,line.length+1]);
  ctx.lineDashOffset=-start;
  ctx.stroke(line.path);
 }

 function createPainter(ctx,wordmark){
  const outline=new Path2D(wordmark.outline);
  const strokes=[
   stroke(0,210,64,[201,70],[182,107,155,172,128,262]),
   stroke(140,585,66,[22,142],[0,139,-12,119,30,93],[100,43,229,14,293,54],
    [347,77,349,113,316,154],[258,230,126,296,62,310],[37,315,34,303,45,296]),
   stroke(500,725,60,[365,166],[404,151,421,176,401,203],[381,235,345,260,331,246],
    [316,231,341,194,365,166]),
   stroke(673,1046,73,[433,253],[453,195,477,130,514,65],[533,120,547,205,568,257],
    [592,180,636,56,679,8]),
   stroke(922,1166,58,[667,159],[696,137,733,143,718,178],[711,204,677,239,649,244],
    [615,252,640,187,667,159]),
   stroke(1070,1334,58,[850,28],[824,59,759,172,765,217],[764,256,790,252,849,209]),
   stroke(1197,1420,56,[831,208],[870,205,953,145,934,135],[906,111,853,161,847,212],
    [840,249,889,250,978,225]),
   stroke(1320,1480,45,[719,123],[787,109,877,72,997,60])
  ];
  const flourish=stroke(1480,1940,2.3,[-21,268],
   [90,351,273,343,437,310],[671,262,918,289,1017,173]);
  const particles=Array.from({length:38},(_,index)=>{
   const offset=(index+.65)/39;
   const origin=pointOn(flourish,flourish.length*ease(offset));
   const phase=index*2.39996;
   return {origin,born:flourish.from+(flourish.to-flourish.from)*offset,
    x:Math.cos(phase)*(10+index%6*4),y:Math.sin(phase)*(13+index%5*6),
    radius:1.1+(index%5)*.36,life:225+(index%7)*33};
  });

  let palette,ink;
  return (canvas,time)=>{
   const sx=canvas.width/sceneWidth,sy=canvas.height/sceneHeight;
   ctx.setTransform(sx,0,0,sy,0,0);
   ctx.clearRect(0,0,sceneWidth,sceneHeight);
   ctx.translate((sceneWidth-markWidth)/2,(sceneHeight-markHeight)/2);
   const dark=document.documentElement.dataset.theme==='dark';
   if(dark!==palette||!ink){
    palette=dark;
    ink=ctx.createLinearGradient(0,0,markWidth,0);
    ink.addColorStop(0,dark?'#a9c4e4':'#10324d');
    ink.addColorStop(.51,dark?'#a9c0dd':'#10324d');
    ink.addColorStop(.73,dark?'#c5b9b0':'#46494b');
    ink.addColorStop(1,dark?'#e8c187':'#94703f');
   }
   const elapsed=Math.max(0,time-brushStart);
   const finalInk=smooth(clamp((elapsed-1400)/195));
   ctx.lineCap='round';
   ctx.lineJoin='round';
   ctx.save();
   ctx.scale(markWidth/wordmark.width,markHeight/wordmark.height);
   ctx.clip(outline,'evenodd');
   ctx.scale(wordmark.width/markWidth,wordmark.height/markHeight);
   ctx.strokeStyle=ink;
   ctx.fillStyle=ink;
   let tip,tipOpacity;
   if(finalInk<1){
    for(const line of strokes){
     const amount=progress(elapsed,line);
     if(amount<=0)continue;
     const end=amount*line.length;
     drawStroke(ctx,line,0,end);
     if(amount<1){
      tip=pointOn(line,end);
      tipOpacity=smooth(clamp(Math.min(amount/.14,(1-amount)/.16)));
     }
    }
   }
   ctx.globalAlpha=finalInk;
   ctx.fillRect(-1,-1,markWidth+2,markHeight+2);
   ctx.restore();

   const flight=progress(elapsed,flourish);
   const gold=dark?'#eac18b':'#ae7937';
   if(flight>0&&elapsed<2170){
    const end=flight*flourish.length;
    ctx.strokeStyle=gold;
    ctx.globalAlpha=(dark?.57:.46)*(1-smooth(clamp((elapsed-1850)/320)));
    drawStroke(ctx,flourish,Math.max(0,end-380),end);
    if(flight<1){
     tip=pointOn(flourish,end);
     tipOpacity=smooth(clamp(Math.min(flight/.1,(1-flight)/.13)));
    }
   }
   for(const mote of particles){
    const age=(elapsed-mote.born)/mote.life;
    if(age<=0||age>=1)continue;
    ctx.globalAlpha=.75*Math.sin(Math.PI*age)*(1-age);
    ctx.fillStyle=gold;
    ctx.beginPath();
    ctx.arc(mote.origin.x+mote.x*age,mote.origin.y+mote.y*age,mote.radius,0,Math.PI*2);
    ctx.fill();
   }
   if(tip&&tipOpacity>0){
    ctx.globalAlpha=.9*tipOpacity;
    const glow=ctx.createRadialGradient(tip.x,tip.y,0,tip.x,tip.y,16);
    glow.addColorStop(0,dark?'#fff4d7':'#fff6de');
    glow.addColorStop(.22,dark?'#ffda9cc4':'#ca8b43b8');
    glow.addColorStop(1,'#d4a65c00');
    ctx.fillStyle=glow;
    ctx.fillRect(tip.x-16,tip.y-16,32,32);
   }
   ctx.globalAlpha=1;
  };
 }

 if(host)host.addEventListener('message',event=>{
  if(event.data?.type!=='yams-one-startup'||document.querySelector('.startup-splash'))return;
  if(matchMedia('(prefers-reduced-motion: reduce)').matches||typeof startupWordmark==='undefined'){
   host.postMessage('startup-splash-exit');
   return;
  }
  const overlay=document.createElement('dialog');
  overlay.className='startup-splash';
  overlay.setAttribute('aria-label','开场动画');
  const canvas=document.createElement('canvas');
  canvas.setAttribute('aria-hidden','true');
  const ctx=canvas.getContext('2d');
  if(!ctx){
   host.postMessage('startup-splash-exit');
   return;
  }
  const draw=createPainter(ctx,startupWordmark);
  overlay.append(canvas);
  document.body.append(overlay);
  overlay.showModal();
  host.postMessage('startup-splash-enter');

  let dirty=true;
  const resize=new ResizeObserver(()=>{dirty=true;});
  resize.observe(canvas);
  const start=performance.now();
  const watchdog=setTimeout(()=>overlay.close(),2800);
  let frame;
  overlay.addEventListener('close',()=>{
   clearTimeout(watchdog);
   cancelAnimationFrame(frame);
   resize.disconnect();
   overlay.remove();
   host.postMessage('startup-splash-exit');
  },{once:true});
  function animate(now){
   if(!overlay.open)return;
   const elapsed=now-start;
   if(elapsed>=duration){
    overlay.close();
    return;
   }
   if(dirty){
    const ratio=window.devicePixelRatio||1;
    canvas.width=Math.max(1,Math.round(canvas.clientWidth*ratio));
    canvas.height=Math.max(1,Math.round(canvas.clientHeight*ratio));
    dirty=false;
   }
   draw(canvas,elapsed);
   if(elapsed>2210)canvas.style.opacity=String(1-smooth(clamp((elapsed-2210)/(duration-2210))));
   frame=requestAnimationFrame(animate);
  }
  frame=requestAnimationFrame(animate);
 });
}
