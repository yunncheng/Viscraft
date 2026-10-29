// Original native 2-D animation. Every pose, contact and tear is a function of film time.
const W=1344,H=768,TAU=Math.PI*2,INK='#263e43';
const canvas=document.getElementById('film'),g=canvas.getContext('2d');
const plate=document.createElement('canvas');plate.width=W;plate.height=H;const c=plate.getContext('2d');
const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,v));
const smooth=(a,b,t)=>{const p=clamp((t-a)/(b-a));return p*p*(3-2*p)};
const hash=n=>{let x=Math.sin(n*127.1+311.7)*43758.5453;return x-Math.floor(x)};
const mix=(a,b,t)=>a+(b-a)*t;
function path(d,fill,stroke=INK,lw=3,ct=c){const p=new Path2D(d);if(fill){ct.fillStyle=fill;ct.fill(p)}if(stroke){ct.strokeStyle=stroke;ct.lineWidth=lw;ct.lineJoin='round';ct.lineCap='round';ct.stroke(p)}return p}
function ell(x,y,rx,ry,fill,stroke=INK,lw=3,ct=c){ct.beginPath();ct.ellipse(x,y,rx,ry,0,0,TAU);if(fill){ct.fillStyle=fill;ct.fill()}if(stroke){ct.strokeStyle=stroke;ct.lineWidth=lw;ct.stroke()}}
function line(points,color=INK,w=3,ct=c){ct.beginPath();points.forEach(([x,y],i)=>i?ct.lineTo(x,y):ct.moveTo(x,y));ct.strokeStyle=color;ct.lineWidth=w;ct.lineJoin='round';ct.lineCap='round';ct.stroke()}
const paper=document.createElement('canvas');paper.width=W;paper.height=H;const pg=paper.getContext('2d');
pg.fillStyle='#fff2d2';pg.fillRect(0,0,W,H);
for(let i=0;i<48000;i++){const x=hash(i+3)*W,y=hash(i+80003)*H;pg.fillStyle=i%3?'rgba(55,44,35,.022)':'rgba(255,255,240,.17)';pg.fillRect(x,y,.5+hash(i+9)*1.4,.4+hash(i+12)*.9)}
function wash(ct,x,y,rx,ry,color,seed=0){ct.save();ct.translate(x,y);ct.scale(rx,ry);ct.beginPath();for(let i=0;i<=24;i++){const a=i/24*TAU,r=.92+.12*hash(seed+i);const px=Math.cos(a)*r,py=Math.sin(a)*r;i?ct.lineTo(px,py):ct.moveTo(px,py)}ct.closePath();ct.fillStyle=color;ct.fill();ct.restore()}
function cloud(x,y,s){c.save();c.translate(x,y);c.scale(s,s);path('M-100 24 C-132 15-112-12-88-9 C-89-46-36-54-20-22 C2-65 71-45 66-9 C101-18 126 19 92 30 Z','#fff4d5',null);path('M-96 28 C-40 32 41 27 91 29',null,'#efddbf',2);c.restore()}
function building(x,base,w,h,col,seed){
 c.save();c.translate(x,base-h);c.fillStyle='rgba(69,91,88,.13)';c.fillRect(10,7,w+9,h);
 path(`M0 0 L${w-5} -3 L${w+3} ${h} L-2 ${h}Z`,col,'#46616a',2.2);
 path(`M-8 1L${w*.5} -${23+hash(seed)*18}L${w+8} -2L${w+5} 11L-6 13Z`,'#bb5b44','#514f48',2.2);
 c.fillStyle='rgba(255,236,193,.24)';c.fillRect(5,17,w*.25,h-17);
 for(let n=0;n<26;n++){const bx=hash(seed+n+521)*w,by=hash(seed+n+723)*h;wash(c,bx,by,6+hash(n+81)*18,10+hash(n+129)*25,n%2?'rgba(253,225,174,.12)':'rgba(153,87,66,.06)',seed+n)}
 for(let n=0;n<6;n++){const rx=8+n*w/6;path(`M${rx} 2q3-9 8-10`,null,'#dd9570',1.2)}
 for(let row=0;row<Math.floor((h-30)/44);row++)for(let k=0;k<2;k++){
 const xx=14+k*(w-36),yy=29+row*44;
 path(`M${xx} ${yy}h15v23h-15Z`,'#427f7b','#42636a',1.4);
 line([[xx+7,yy+1],[xx+7,yy+22]],'#eecf98',1.4);
 line([[xx,yy+12],[xx+15,yy+12]],'#eecf98',1.2);
 path(`M${xx-6} ${yy-1}v25h-7v-25Z`,'#5e9a8a','#416e6c',.8);
 path(`M${xx+21} ${yy-1}v25h7v-25Z`,'#5e9a8a','#416e6c',.8);
 if(row===1){path(`M${xx-8} ${yy+23}h37v6h-37Z`,'#e8bd84','#665e4c',1);for(let m=0;m<5;m++){ell(xx-3+m*7,yy+20,5,4,m%2?'#d67977':'#6a9567',null)}}
 line([[xx-4,yy],[xx-4,yy+24],[xx-7,yy+23]],'#ecaf7a',2);
 }
 path(`M${w*.43} ${h}v-33q12-18 23 0v33`,'#367776','#354f56',2);
 for(let i=0;i<24;i++){const xx=hash(seed+i+21)*w,yy=20+hash(seed+i+64)*(h-26);line([[xx,yy],[xx+4,yy]],'rgba(97,67,48,.16)',1)}
 for(let k=0;k<8;k++){const xx=w-6+Math.sin(k*1.7)*7,yy=h-20-k*12;ell(xx,yy,8,4,k%2?'#7c9b6a':'#5e8967',null);if(k%3===0)ell(xx+6,yy-2,3,3,'#d68e99',null)}
 c.restore();
}
function shrub(x,y,s,seed){c.save();c.translate(x,y);c.scale(s,s);for(let i=0;i<24;i++){const a=hash(seed+i)*TAU,r=hash(seed+i+21)*55;wash(c,Math.cos(a)*r,-Math.sin(a)*r*.6,15,10,i%3?'#47755c':'#78955b',seed+i)}for(let i=0;i<12;i++){const a=hash(seed+i+8)*TAU,r=hash(seed+i+89)*48;ell(Math.cos(a)*r,-Math.abs(Math.sin(a)*r)*.6,4,4,i%3?'#ef8b78':'#f3c668',null)}c.restore()}
function scenery(t,d){
 if(loaded.has('paintedTown')){
  const im=loaded.get('paintedTown'),sc=Math.max(W/im.width,H/im.height)*1.18;
  c.drawImage(im,-40-d*.11,-40,im.width*sc,im.height*sc);
  // Animated thin ink-and-paint glints sit on the retained harbour painting.
  for(let i=0;i<22;i++){const xx=hash(i+112)*W-(d*.06)%80,yy=373+hash(i+92)*95;
   const a=.18+.12*Math.sin(t*2.1+i);line([[xx,yy],[xx+9+hash(i+22)*18,yy]],`rgba(255,236,169,${a})`,1.3)}
  // Near-ground marks scroll faster than the painted distance, supporting forward travel.
  for(let i=0;i<55;i++){let x=(hash(i+123)*1600-d)%1600;if(x<0)x+=1600;const y=600+hash(i+51)*95;line([[x,y],[x+4+hash(i+44)*7,y-1]],'rgba(152,111,63,.18)',1.1)}
  c.save();c.globalCompositeOperation='multiply';c.globalAlpha=.10;c.drawImage(paper,0,0);c.restore();return;
 }

 let sky=c.createLinearGradient(0,50,0,410);sky.addColorStop(0,'#65c4cb');sky.addColorStop(1,'#c6e8d5');c.fillStyle=sky;c.fillRect(0,0,W,H);
 ell(1100,142,58,58,'#ffda8a',null);cloud(270-(d*.07)%160,150,.8);cloud(850-(d*.04)%120,111,.55);
 // Stacked distant coast silhouettes, pencil contours and pigment wash.
 path('M0 353 Q99 270 224 310 T480 285 Q600 230 720 306 T1010 265 Q1180 258 1344 324V450H0Z','#85b8ae',null);
 path('M-30 368Q80 310 180 350T420 319Q565 282 671 345T975 312Q1160 288 1370 360V420H-30Z','#568e91','#507c7b',2);
 c.fillStyle='#4aa7ae';c.fillRect(0,357,W,196);
 for(let k=0;k<18;k++){const sx=hash(k+318)*W,sy=360+hash(k+815)*80;wash(c,sx,sy,65+hash(k+13)*60,4+hash(k+2)*12,k%2?'rgba(27,120,142,.13)':'rgba(156,218,198,.18)',k+30)}
 for(let i=0;i<70;i++){const y=366+hash(i+31)*171,x=(hash(i+22)*1550-d*.22)%1550;line([[x,y],[x+12+hash(i+2)*60,y-1]],i%4?'rgba(236,243,212,.60)':'#317f91',1+hash(i+52))}
 // Two parallax town layers. No background sprite carries a baked-in protagonist.
 const scroll=(d*.35)%1490;
 for(let rep=-1;rep<3;rep++)for(let i=0;i<10;i++){
 const x=rep*1490+i*146-scroll,hh=70+hash(i+6)*112;
 building(x,384,78+hash(i+2)*35,hh,['#ef9b77','#e7c48e','#e9ac8d','#da8375','#f3d3a2'][i%5],i*31);
 }
 // A few inked sails behind the parapet give the village a lived-in harbour.
 for(let k=0;k<3;k++){const bx=210+k*490-(d*.12)%90,by=420+Math.sin(k)*13;path(`M${bx-24} ${by}q24 19 49 0Z`,'#f9dda8','#355d68',1.6);line([[bx,by],[bx,by-43]],'#446e73',1.6);path(`M${bx+2} ${by-40}l23 35h-23Z`,'#ffedc9','#557d7c',1.1)}
 // Shore wall and creamy stone walkway.
 path('M-20 464Q380 448 710 456T1370 451V534H-20Z','#dfcf9f','#4f7771',3);
 path('M-20 460Q500 451 1370 451L1370 470Q590 467-20 479Z','#fff0be','#657b6c',2);
 for(let i=-1;i<19;i++){const x=i*100-(d*.9)%100;line([[x,477],[x-9,522]],'#b4ae87',1.3)}
 let road=c.createLinearGradient(0,495,0,H);road.addColorStop(0,'#f4d28c');road.addColorStop(1,'#eab877');c.fillStyle=road;c.fillRect(0,524,W,244);
 for(let i=0;i<90;i++){let x=(hash(i+28)*1700-d*1.0)%1700;if(x<0)x+=1700;const y=540+hash(i+4)*192;line([[x,y],[x+5+hash(i+87)*15,y-2]],'rgba(137,108,65,.17)',1.2)}
 // Tall nearby painted houses pass in foreground; open water remains behind the hero.
 const xs=((-d*.68+230)%1900+1900)%1900-400;
 building(xs,498,155,330,'#e89476',891);shrub(xs-5,505,.8,90);shrub(xs+161,498,.65,191);
 // Rhythmic roadside flowers and their inked stems.
 for(let j=-1;j<5;j++){const x=j*540-(d*1.28)%540;shrub(x,706,1.15,44+j*71)}
 c.save();c.globalAlpha=.16;c.globalCompositeOperation='multiply';c.drawImage(paper,0,0);c.restore();
}
function wheel(x,y,a,far=false){
 ell(x,y,80,80,null,INK,12);ell(x,y,80,80,null,'#efe0b2',8);ell(x,y,73,73,null,'#617f7c',2);
 c.save();c.translate(x,y);c.rotate(a);
 for(let i=0;i<18;i++){const q=i/18*TAU;line([[0,0],[Math.cos(q)*72,Math.sin(q)*72]],'#78958b',1.15)}
 path('M-68-21A72 72 0 0 1 35-63',null,'#fff5d7',2.4);ell(0,0,7,7,'#dfc08c',INK,2);c.restore();
 // A rotating painted valve makes rotation legible independently of spokes.
 ell(x+Math.cos(a+.8)*77,y+Math.sin(a+.8)*77,2.2,3.6,'#ac6455',null);
}
function pedalPosition(a){return{x:-12+24*Math.cos(a),y:-46+24*Math.sin(a)}}
function leg(a,far,bob){
 const foot=pedalPosition(a),hip={x:-47+(far?-10:0),y:-139+bob};
 const knee={x:mix(hip.x,foot.x,.48)+29,y:mix(hip.y,foot.y,.47)-7};
 path(`M${hip.x-6} ${hip.y}Q${knee.x-5} ${knee.y} ${foot.x-6} ${foot.y-6}L${foot.x+6} ${foot.y-5}Q${knee.x+9} ${knee.y+6} ${hip.x+9} ${hip.y+3}Z`,far?'#d88f47':'#f8ae56',INK,2.4);
 path(`M${foot.x-9} ${foot.y-6}Q${foot.x+1} ${foot.y-13} ${foot.x+11} ${foot.y-6}L${foot.x+31} ${foot.y+2}Q${foot.x+34} ${foot.y+9} ${foot.x+20} ${foot.y+8}L${foot.x-9} ${foot.y+5}Z`,far?'#d98a43':'#f4ae57',INK,2.4);
 line([[foot.x+9,foot.y],[foot.x+22,foot.y+4]],'#b87140',1.3);
 c.save();c.translate(foot.x,foot.y+7);c.rotate(-.05*Math.sin(a));path('M-12-3h27v5h-27Z','#435d5d',INK,1.4);c.restore();
}
function bird(t,a,lean,bob){
 c.save();c.translate(-38,-192+bob);c.rotate(lean);
 // Warm shaded body and a separate sculpted wing, rather than an icon on a human rig.
 const body=path('M-82-27C-115-11-121 43-90 69C-62 98 4 89 33 62C57 38 47-9 11-32C-14-49-50-44-82-27Z','#fff1cf',INK,3.7);
 c.save();c.clip(body);path('M-128 22Q-58 84 39 41L64 109H-128Z','#ddcfa8',null);for(let k=0;k<12;k++){wash(c,-94+hash(k+52)*108,-20+hash(k+42)*81,16+hash(k+71)*21,9+hash(k+2)*13,k%2?'rgba(192,159,105,.10)':'rgba(255,255,233,.29)',k+511)}for(let i=0;i<49;i++){const x=-93+hash(i+10)*121,y=-23+hash(i+90)*83;path(`M${x} ${y}q6 9 15 5`,null,i%3?'rgba(160,139,105,.35)':'rgba(255,255,239,.85)',1.6)}c.restore();
 // Tail feathers catch the wind behind the saddle.
 for(let i=0;i<4;i++)path(`M-87 27Q-${131+i*6} ${40+Math.sin(t*8+i)*4} -${101+i*5} ${63+i*3}Q-78 59-63 43Z`,i%2?'#8d9d91':'#b4b5a0',INK,2);
 // Long flexible neck and rounded juvenile head.
 const neck=path('M-48-12C-44-54-53-106-26-135C-9-152 16-153 30-140C54-117 27-97 18-72C10-48 25-28 35-13C17 10-20 13-48-12Z','#fff4d6',INK,3.5);
 c.save();c.clip(neck);path('M-50-148Q-24-89-16-22L14 8L-61 4Z','#e6d7b1',null);c.restore();
 ell(12,-146,44,43,'#fff4d6',INK,3.6);
 path('M-20-173Q-39-203-18-186Q-19-211-5-184Q3-209 8-184Q21-200 19-178','#fff4d6',INK,2.3);
 // Bill and warm translucent throat pouch, key pelican identification.
 path('M40-153Q83-145 158-116Q174-108 163-104Q95-64 48-103Q34-117 38-139Z','#f4b16b',INK,3.2);
 path('M38-155Q85-149 166-111L168-104Q104-123 41-133Z','#ffd28c',INK,2.8);
 path('M48-127Q85-82 151-108',null,'#d68752',1.4);
 path('M49-147L142-117',null,'#ffe8b3',2.2);
 // Eye blink and glance are authored independently of the head/cycle.
 const blink=Math.min(Math.abs(t-2.35),Math.abs(t-5.02));
 if(blink<.10){path('M16-157q10-5 18 0',null,INK,3.2)}else{
 ell(25,-158,12,16,'#fffdf0',INK,2);ell(29+(t>5.5?2:0),-157,6,9,'#293e42',null);ell(31,-162,2.2,3,'#fffefa',null);
 }
 path('M13-181Q28-188 38-177',null,INK,2.4);
 ell(40,-133,9,5,'rgba(227,133,106,.30)',null);
 // Overlapping long feathers form the wing and extend naturally to the handlebar.
 c.save();c.translate(-55,-7);c.rotate(-.06+Math.sin(t*7)*.018);
 path('M-17-10C2-37 48-27 69-2L126 24L215 48Q232 49 232 61Q231 73 215 67L124 50Q23 48-10 20Z','#f6e8c9',INK,3.4);
 path('M110 29Q160 45 216 56',null,'#c3c3aa',6);
 for(let j=0;j<5;j++){const xx=145+j*15;path(`M${xx} 43q9 4 13 15`,null,'#7d9185',1.4)}
 for(let i=0;i<7;i++){let x=-10+i*13;path(`M${x} 3Q${x+19} -14 ${x+38} 15Q${x+44} 23 ${x+29} 26L${x+8} 21`,i>3?'#bdc1ae':'#eadcbb','#70867e',1.4)}
 path('M216 50q13-8 17 4q5 13-6 17l-2-17q-5-3-9 4',null,INK,3.5);c.restore();
 // Subtle feather filaments on the crown and breast keep the ink lively.
 for(let i=0;i<9;i++){let y=-109+i*10;path(`M-25 ${y}q4 4 7 1`,null,'#c6bc9c',1.3)}
 c.restore();
}
function rider(t,d,frontContact=false){
 const accel=smooth(4.9,7.5,t),x=530+126*accel,y=548;
 const stumble=Math.exp(-Math.pow((t-2.6)/.31,2));
 const bob=2.8*Math.sin(d/23)-5*stumble;
 const tilt=.009*Math.sin(d/82)+.035*stumble;
 const scale=1.12;
 c.save();c.translate(x,y);c.scale(scale,scale);c.rotate(tilt);
 ell(8,89,211,15,'rgba(99,91,60,.15)',null);
 const angle=d/83,pa=d/44;
 leg(pa+Math.PI,true,bob);
 wheel(-115,0,angle);wheel(125,0,angle);
 // Fenders, teal enamel frame, fork and chain have their own physical points.
 path('M-191-14A78 78 0 0 1-40-27',null,'#326f70',6);path('M51-28A78 78 0 0 1 202-17',null,'#326f70',6);
 const frame=[[-115,0],[-52,-98],[-12,-46],[-115,0],[-12,-46],[97,-105],[125,0]];
 line(frame,INK,10);line(frame,'#4c9c93',6);
 path('M-52-98Q-29-61-12-46Q33-26 97-105',null,INK,10);path('M-52-98Q-29-61-12-46Q33-26 97-105',null,'#56b1a0',5.8);
 line([[-52,-98],[-59,-126]],INK,7);path('M-86-129Q-48-141-32-128Q-39-116-85-120Z','#9d674c',INK,3);
 path('M125 0L88-133Q96-154 118-152L134-143',null,INK,8);path('M125 0L88-133Q96-154 118-152L134-143',null,'#c5ccad',4.5);
 path('M117-153Q137-158 142-142',null,INK,7);
 path('M-115 0L-12-46',null,'#4c655f',3);ell(-12,-46,16,16,'#8b9d8a',INK,2);
 line([[-12,-46],[pedalPosition(pa).x,pedalPosition(pa).y]],'#536e66',4);
 bird(t,pa,-.045*accel-.025*stumble,bob);
 leg(pa,false,bob);
 // Gentle brake cable and a tiny brass bell.
 path('M119-148Q81-106 121-7',null,'#3e5755',1.5);ell(107,-153,7,4,'#f4c564',INK,1.5);
 c.restore();
 if(stumble>.12){for(let i=0;i<3;i++){const xx=x-160-i*15;path(`M${xx} ${y-270+i*10}q-9-7-16-2`,null,'#fff1ba',2.5)}}
 return {x,y,scale,front:x+208*scale};
}
function distance(t){const q=Math.max(0,t-5);return 145*t+48*Math.min(q,2.6)**2+250*Math.max(0,q-2.6)}
function raggedHole(cx,cy,r,t,ct){ct.beginPath();for(let i=0;i<=74;i++){const a=i/74*TAU;const rr=r*(.90+.12*hash(i+63))+(i%2?7:-6);const x=cx+Math.cos(a)*rr,y=cy+Math.sin(a)*rr*.79;i?ct.lineTo(x,y):ct.moveTo(x,y)}ct.closePath()}
const loaded=new Map();let lastParams={};
async function loadImage(url){const im=new Image();im.src=url;await im.decode();return im}
async function ensureBindings(bindings){await Promise.all(Object.entries(bindings).filter(([key])=>!loaded.has(key)).map(async([key,b])=>loaded.set(key,await loadImage(b.url))))}
function cover(ct,im){const s=Math.max(W/im.width,H/im.height);ct.drawImage(im,(W-im.width*s)/2,(H-im.height*s)/2,im.width*s,im.height*s)}
function coast(ct,t,bindings){const f=Math.max(0,Math.min(33,Math.floor((t-182/24)*24+.001)));const im=loaded.get('entry'+String(f).padStart(3,'0'))||loaded.get('coastReference');if(im)cover(ct,im);else{ct.fillStyle='#eeb57b';ct.fillRect(0,0,W,H)}}
function draw(t,bindings,params){
 if(params.proxyTime)t=182/24+t*.35;
 c.setTransform(1,0,0,1,0,0);c.globalAlpha=1;c.globalCompositeOperation='source-over';c.clearRect(0,0,W,H);
 c.drawImage(paper,0,0);
 if(params.anchor){
  scenery(t,distance(t));rider(t,distance(t));
  g.setTransform(canvas.width/W,0,0,canvas.height/H,0,0);g.clearRect(0,0,W,H);g.drawImage(plate,0,0);
  g.fillStyle='#17232a';g.fillRect(0,0,W,32);g.fillRect(0,H-32,W,32);return;
 }

 const d=distance(t),start=182/24,tear=clamp((t-start)/1.22),wall=1340-Math.max(0,t-5.3)*202;
 const anticipation=Math.exp(-(((t-(start-.13))/.13)**2))*13;
 c.save();c.beginPath();c.rect(28,54,Math.min(1288,wall-28+anticipation),658);c.clip();scenery(t,d);rider(t,d);c.restore();
 // A complete tangible paper panel, including a thick ink border and bright gutter.
 path(`M29 55Q${wall*.5} 52 ${Math.min(1317,wall+anticipation)} 55L${Math.min(1317,wall+anticipation)} 711Q630 715 28 709Z`,null,INK,5.0);
 if(wall<1310){
  path(`M${wall+17} 55L${wall+17} 712`,null,'#d6b58c',1.5);
  for(let k=0;k<5;k++)path(`M${wall+37} ${170+k*82}q75-26 165-7`,null,'rgba(80,151,157,.13)',7);
 }
 // Warm lithographic hatching: stable marks belong to the painted world.
 c.save();c.beginPath();c.rect(29,55,Math.min(1287,wall-29),656);c.clip();
 for(let i=0;i<1600;i++){const xx=hash(i+4981)*W,yy=hash(i+1873)*H;line([[xx,yy],[xx+1+hash(i+12)*4,yy-1]],i%3?'rgba(63,74,62,.045)':'rgba(255,247,207,.19)',.8)}c.restore();
 // Fine stable paper tooth sits in the ink and colour, not a new random frame filter.
 c.save();c.globalCompositeOperation='multiply';c.globalAlpha=.12;c.drawImage(paper,0,0);c.restore();
 g.setTransform(canvas.width/W,0,0,canvas.height/H,0,0);g.clearRect(0,0,W,H);
 if(tear>0){coast(g,t,bindings);
  // Rip starts at the wheel contact and grows; it is an aperture, never an opacity dissolve.
  const r=9+Math.pow(tear,1.42)*1730;
  c.save();c.globalCompositeOperation='destination-out';raggedHole(888,503,r,t,c);c.fill();c.restore();
  g.drawImage(plate,0,0);
  if(tear<.91){raggedHole(888,503,r,t,g);g.strokeStyle='#fff6d9';g.lineWidth=12;g.stroke();g.strokeStyle='rgba(122,88,58,.42)';g.lineWidth=1.4;g.stroke();}
  // Torn, rotating paper shards peel out of the ink frame and become light motes.
  const age=t-start;
  for(let i=0;i<62;i++){
   const delay=hash(i+12)*.23,a=Math.max(0,age-delay);if(a<=0)continue;
   const th=(hash(i+61)*1.6+.2)*Math.PI,vel=180+hash(i+31)*640;
   const px=888+Math.cos(th)*vel*a,py=503+Math.sin(th)*vel*a-240*a+120*a*a;
   const lum=smooth(.22,.94,a),alpha=(1-smooth(.72,1.4,a));if(alpha<=0)continue;
   g.save();g.translate(px,py);g.rotate((i%2?1:-1)*a*(2+hash(i+29)*9));g.globalAlpha=alpha;
   if(lum<.78){const sz=(6+hash(i+8)*22)*(1-.75*lum);g.scale(.35+Math.abs(Math.cos(a*7+i))*.8,1);path(`M-${sz} 0L0-${sz*.5}L${sz} 0L${sz*.4} ${sz}Z`,i%4?'#fff0c6':'#5eaaa6','rgba(62,78,67,.45)',1.2,g)}
   else{g.shadowColor='#ffe1a0';g.shadowBlur=14;ell(0,0,2+hash(i+1)*3,2+hash(i+1)*3,'#fff6cd',null,0,g)}g.restore();
  }
 }else{g.drawImage(plate,0,0)}
 // Letterbox is shared by code and coastal footage in finishing, 2.00:1 viewing window.
 g.fillStyle='#17232a';g.fillRect(0,0,W,32);g.fillRect(0,H-32,W,32);
}
window.viscraft={
 ready:async()=>{},
 render:async({time,frame,width,height,bindings={},params={}})=>{if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height}await ensureBindings(bindings);draw(time,bindings,params)},
};
// Direct local preview: deterministic requested time, no production animation clock.
window.renderPelicanFrame=async(t)=>{await window.viscraft.render({time:t,frame:Math.round(t*24),width:W,height:H,bindings:{},params:{}})};
