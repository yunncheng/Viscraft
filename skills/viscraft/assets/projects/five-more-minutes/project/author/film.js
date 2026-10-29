/* Original drawing and animation, authored for 再等五分钟. Pure frame-clock rendering. */
const canvas=document.querySelector('canvas'),c=canvas.getContext('2d');
const W=1280,H=720,PI=Math.PI;
const C={paper:'#f7efdd',ink:'#575859',blue:'#a8c8ce',deep:'#547a8a',pink:'#db8d82',yellow:'#e5bd72',green:'#99ac88',sage:'#b6c3a2',white:'#fff9e9'};
let T=0,Q=0;
function rand(s){const x=Math.sin(s*127.1+311.7)*43758.5453;return x-Math.floor(x)}
const clamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,x));
const ease=x=>(x=clamp(x))*x*(3-2*x);
const mix=(a,b,t)=>a+(b-a)*t;
const pulse=(t,a,b)=>Math.sin(clamp((t-a)/(b-a))*PI);
function path(d){return new Path2D(d)}
function line(d,color=C.ink,w=2){c.strokeStyle=color;c.lineWidth=w;c.lineCap='round';c.lineJoin='round';c.stroke(typeof d==='string'?path(d):d)}
// The stage uses logical coordinates; paths, type and paper render at capture pixels.
const paper=document.createElement('canvas');
function prepareSurface(width,height){
 if(canvas.width===width&&canvas.height===height&&paper.width===width&&paper.height===height)return;
 canvas.width=paper.width=width;canvas.height=paper.height=height;
 const pc=paper.getContext('2d'),pd=pc.createImageData(width,height);
 for(let i=0;i<width*height;i++){const n=(rand(i+8)-.5)*14,tooth=2*Math.sin(i%width*.55);pd.data.set([247+n+tooth,239+n,222+n,255],i*4)}
 pc.putImageData(pd,0,0);
}
const tooth=document.createElement('canvas');tooth.width=256;tooth.height=256;
const tc=tooth.getContext('2d'),td=tc.createImageData(256,256);
for(let i=0;i<65536;i++){let n=rand(i+770);td.data.set([70,77,71,n>.70?(n-.7)*100:0],i*4)}tc.putImageData(td,0,0);
const grain=c.createPattern(tooth,'repeat');
const pigmentCanvas=document.createElement('canvas');pigmentCanvas.width=384;pigmentCanvas.height=384;
const pg=pigmentCanvas.getContext('2d'),pgi=pg.createImageData(384,384);
function smoothNoise(x,y,n){let a=Math.floor(x/n),b=Math.floor(y/n),u=ease(x/n-a),v=ease(y/n-b);return mix(mix(rand(a+b*131+n),rand(a+1+b*131+n),u),mix(rand(a+(b+1)*131+n),rand(a+1+(b+1)*131+n),u),v)}
for(let y=0;y<384;y++)for(let x=0;x<384;x++){const n=smoothNoise(x,y,64)*.55+smoothNoise(x,y,19)*.30+smoothNoise(x,y,6)*.15;const i=(y*384+x)*4;pgi.data.set([62,79,73,Math.max(0,n-.24)*53],i)}
pg.putImageData(pgi,0,0);const pigment=c.createPattern(pigmentCanvas,'repeat');
function paint(d,color,stroke=true,alpha=1){let p=typeof d==='string'?path(d):d;c.save();c.globalAlpha*=alpha;c.fillStyle=color;c.fill(p);c.save();c.clip(p);c.globalAlpha*=.65;c.fillStyle=grain;c.fillRect(-2200,-1600,5000,4000);c.fillStyle=pigment;c.fillRect(-2200,-1600,5000,4000);c.restore();c.save();c.globalAlpha*=.19;line(p,color,4.5);c.restore();if(stroke){line(p,C.ink,1.65);c.save();c.translate(.65,-.75);c.globalAlpha*=.24;line(p,C.ink,.8);c.restore()}c.restore()}
function ellipse(x,y,rx,ry,color,stroke=false){let p=new Path2D();p.ellipse(x,y,rx,ry,0,0,2*PI);paint(p,color,stroke)}
function text(s,x,y,size=27,color=C.ink,align='center',weight=430){c.save();c.font=`${weight} ${size}px Story`;c.textAlign=align;c.textBaseline='middle';c.fillStyle=color;c.fillText(s,x,y);c.restore()}
function transform(x,y,s,r,fn){c.save();c.translate(x,y);c.rotate(r);c.scale(s,s);fn();c.restore()}
function wash(x,y,rx,ry,col,a=.2){c.save();c.translate(x,y);c.scale(rx,ry);c.globalAlpha*=a;const g=c.createRadialGradient(0,0,.1,0,0,1);g.addColorStop(0,col);g.addColorStop(.48,col+'b0');g.addColorStop(1,col+'00');c.fillStyle=g;c.fillRect(-1,-1,2,2);c.restore()}
function ground(t,wet=0){
 wash(660,245,660,320,'#9fc9d4',.36);wash(260,180,260,180,'#efc68b',.12);
 paint('M -50 488 Q 100 386 280 446 Q 470 343 668 432 Q 925 356 1320 425 L 1320 750 L -50 750 Z','#c8d2b2',false);
 paint('M -30 550 Q 220 419 476 515 Q 800 387 1320 531 L 1320 750 L -30 750Z',wet?'#a3bf99':'#bcc79f',false);
 paint('M -20 608 Q 250 511 462 579 Q 800 485 1300 567 L 1320 750 L -30 750 Z',wet?'#9eb58b':'#b1bc90',false);
 paint('M 640 720 Q 621 617 712 567 Q 773 540 816 526 Q 778 572 732 603 Q 689 638 723 720Z','#e4d2aa',false);
 for(let k=0;k<10;k++){let x=40+k*145,y=440+(k%3)*23;tree(x,y,.4+(k%2)*.1,t)}
 cottage(1040,476,.65);cottage(1120,485,.40);
 for(let k=0;k<64;k++){let x=rand(k+67)*1300,y=570+rand(k+99)*160;let a=Math.sin(t*1.7+k)*3;line(`M${x} ${y}q${a-4} -12 ${a-2} -22`,wet?'#6e916d':'#87966d',1);if(k%3===0){ellipse(x+a-2,y-23,3.5,3.4,[C.yellow,C.pink,'#f2e3b2'][k%3]);}}
}
function tree(x,y,s,t){transform(x,y,s,Math.sin(t+kseed(x))*.025,()=>{line('M0 0 Q-3 -70 4 -129','#897d65',5);paint('M-5 -56 C-83 -36 -85 -100 -54 -114 C-91 -169 -27 -191 0 -171 C 37 -218 89 -164 63 -134 C122 -91 60 -39 -5 -56Z','#b1c1a0',false);line('M0 -50 Q-13 -94 -38 -119 M2 -69 Q26 -100 43 -129','#8c9a7e',1.5)})}
function kseed(x){return x*.03}
function cottage(x,y,s){transform(x,y,s,0,()=>{paint('M-58 -4 L-58 -75 L50 -75 L50 -4Z','#f6dfb1');paint('M-74 -72 L-7 -128 L67 -72Z','#cc9380');paint('M12 -4 L12 -50 Q26 -65 38 -50 L38 -4Z','#a5ac98');paint('M-38 -57 L-13 -57 L-13 -30 L-38 -30Z','#9db6b8');line('M-25 -57 V-30 M-38 -44 H-13','#ebdcc0');line('M-29 -97 L22 -97 M-44 -86 L39 -86','#aa7c71',1);})}
function bird(x,y,s,t){transform(x,y,s,0,()=>{let f=Math.sin(t*8)*13;line(`M-20 ${f} Q-8 -6 0 1 Q9 -7 22 ${f}`,C.deep,2)})}
function scarf(){paint('M-106 29 Q-72 52 -41 40 L-45 62 Q-84 66 -112 46Z',C.pink);paint(`M-102 45 Q-142 69 -166 ${73+Math.sin(T*4)*6} L-145 47 Q-122 55 -102 45Z`,'#c77f78');line('M-101 50 Q-128 65 -148 62','#9c6d69',1)}
function cloud(x,y,s=1,mood='happy',r=0,gesture='idle',extra={}){
 transform(x,y,s,r,()=>{
 const breath=Math.sin(Q*2.8)*.016,jit=Math.sin(Q*9)*.5;
 c.save();c.scale(extra.sx||1,extra.sy||1+breath);
 const d=`M-143 32 C-190 24 -187 -41 -144 -49 C-160 -101 -106 -139 -65 -106 C-46 -158 31 -146 42 -99 C89 -143 142 -105 139 -63 C193 -68 204 0 163 23 C155 58 112 65 80 49 C35 77 -22 62 -42 53 C-76 73 -123 64 -143 32Z`;
 c.translate(jit,Math.cos(Q*9)*.35);paint(d,C.white);
 c.save();c.clip(path(d));wash(0,51,186,43,'#93bac7',.5);wash(-75,-85,76,61,'#fffdf4',.9);wash(121,-30,58,61,'#c5d8d8',.32);c.restore();
 line('M-138 -37 Q-127 -53 -112 -45 M-61 -97 Q-47 -110 -31 -103 M88 -77 Q107 -85 121 -65','#c2cdc5',1.4);
 scarf();
 ellipse(-62,7,22,12,'#e8b1a0');ellipse(65,7,22,12,'#e8b1a0');
 const blink=(Math.floor(Q*12)%53)>50;
 for(let side of [-1,1]){let ex=side*43,ey=-20;
 if(mood==='sleep'||blink){line(`M${ex-12} ${ey}q12 12 24 0`,C.ink,2.9)}
 else if(mood==='joy'){line(`M${ex-12} ${ey+4}q12 -20 24 0`,C.ink,3)}
 else{let wide=mood==='scared'?1.35:1;ellipse(ex,ey,8,13*wide,C.ink);ellipse(ex-2,ey-5,2.4,3.4,C.white);}
 if(mood==='scared')line(`M${ex-14} ${ey-30}q10 ${side*6} 24 -4`,C.ink,2.1);
 if(mood==='sad')line(`M${ex-14} ${ey-24}q12 ${side*12} 24 0`,C.ink,2);
 }
 if(mood==='scared')ellipse(0,16,9,13,'#81665f',true);
 else if(mood==='sleep')ellipse(4,18,7,5,'#a2786b');
 else if(mood==='sad')line('M-14 22 Q0 8 14 22',C.ink,2.6);
 else if(mood==='joy'){paint('M-21 10 Q0 21 22 10 Q20 46 0 44 Q-17 44 -21 10Z','#856c67');ellipse(0,34,12,6,'#db9b8f')}
 else line('M-17 14 Q0 31 19 12',C.ink,2.6);
 if(mood==='scared'){paint('M105 -41 Q127 -12 115 -8 Q99 -11 105 -41Z','#a1c5cf');}
 c.restore();
 if(gesture==='idle'){arm(-137,18,-173,52,-150,71);arm(146,15,173,38,158,59)}
 if(gesture==='spread'){arm(-141,17,-196,-8,-216,-40);arm(145,14,200,-3,218,-40)}
 if(gesture==='hold'){arm(-140,17,-174,75,-60,86);arm(146,16,170,83,58,86)}
 if(gesture==='reach'){arm(-141,17,-189,55,-192,86);arm(146,14,205,50,210,83)}
 if(gesture==='hug'){arm(-140,18,-156,68,-14,55);arm(146,15,151,64,18,54)}
 });
}
function arm(ax,ay,bx,by,dx,dy){line(`M${ax} ${ay} Q${bx} ${by} ${dx} ${dy}`,C.ink,2.6);ellipse(dx,dy,7,5,C.white,true);line(`M${dx-2} ${dy-1}l-4 -6`,C.ink,1)}
function drop(x,y,s=1,face=false,r=0){transform(x,y,s,r,()=>{paint('M0 -36 C-6 -21 -23 -4 -21 12 C-18 42 25 40 23 10 C22 -4 6 -22 0 -36Z','#91bdcd');line('M-9 -1 Q-16 9 -10 18','#eaf3e7',3);if(face){ellipse(-7,12,2.2,3,C.deep);ellipse(9,12,2.2,3,C.deep);line('M-2 22 Q2 27 7 21',C.deep,1.5)}})}
function bubble(s,x,y,w=225){c.save();paint(`M${x-w/2} ${y-29} Q${x-w/2-12} ${y-47} ${x-w/2+18} ${y-48} L${x+w/2-18} ${y-48} Q${x+w/2+15} ${y-43} ${x+w/2} ${y-20} L${x+w/2} ${y+12} Q${x+w/2} ${y+28} ${x+w/2-17} ${y+28} L${x-24} ${y+28} L${x-47} ${y+47} L${x-41} ${y+28} L${x-w/2+14} ${y+28} Q${x-w/2-5} ${y+25} ${x-w/2} ${y-29}Z`,C.white);text(s,x,y-7,24);c.restore()}
function caption(s){c.save();c.fillStyle='rgba(247,239,221,.88)';c.fillRect(0,645,1280,75);text(s,640,680,25,'#5f625d');c.restore()}
function flower(x,y,s=1,happy=false,age=0){transform(x,y,s,Math.sin(Q*2)*.025,()=>{
 const tilt=happy?Math.sin(Q*3)*.07:.36;
 line('M0 0 Q12 -53 -4 -111','#7b966f',4);
 paint('M6 -35 Q-46 -80 -44 -46 Q-32 -27 6 -35Z','#9fb78b');paint('M8 -55 Q56 -92 51 -61 Q40 -42 8 -55Z','#afc293');
 transform(-4,-112,1,tilt,()=>{for(let a=0;a<7;a++){transform(0,0,1,a*PI*2/7,()=>{paint('M0 -8 C-30 -21 -31 -48 -7 -48 C18 -50 23 -25 7 -9Z',happy?'#e6aba2':'#d9b19d')})}ellipse(0,0,25,24,C.yellow,true);if(happy){line('M-14 -1 q5 -8 10 0 M5 -1 q5 -8 10 0',C.ink,1.7);line('M-6 9 q6 9 13 0',C.ink,2)}else{line('M-15 0 l10 2 M6 2 l10 -2',C.ink,2);line('M-4 12 q6 -5 11 0',C.ink,1.5)}});
 line('M-3 -68 Q-39 -49 -46 -33','#839a74',3);line('M7 -63 Q47 -53 43 -31','#839a74',3);
 cup(-12,-37,.8,age);})}
function cup(x,y,s=1,wet=0){transform(x,y,s,0,()=>{paint('M-38 -8 L-29 31 Q0 43 28 30 L38 -8Z','#f4e7c6');paint('M-37 -7 Q0 -24 38 -7 Q0 8 -37 -7Z',wet?'#9fc6ce':'#ddcba9');line('M34 -1 C66 -9 61 34 30 23','#a18d72',3);if(wet){ellipse(0,-6,24*wet,4*wet,'#bdd9d9');}})}
function rainbow(x,y,s=1,alpha=.7){c.save();c.translate(x,y);c.scale(s,s);c.globalAlpha=alpha;const cols=['#dca299','#e4ba7a','#e3cf93','#acbf9c','#97b9c0'];cols.forEach((col,i)=>{c.beginPath();c.arc(0,0,148-i*12,PI,2*PI);c.lineWidth=12;c.strokeStyle=col;c.stroke()});c.restore()}
function butterfly(x,y,s,t){transform(x,y,s,Math.sin(t*2)*.3,()=>{ellipse(-7,0,8*Math.abs(Math.cos(t*8))+1,12,C.pink);ellipse(7,0,8*Math.abs(Math.cos(t*8))+1,12,C.yellow);line('M0 -6 V9',C.ink,1.4)})}
function clock(x,y,s,t){transform(x,y,s,Math.sin(t*15)*.06,()=>{paint('M-34 -39 Q-52 -56 -28 -65 L-7 -52Z',C.pink);paint('M12 -52 Q35 -70 45 -49 L34 -36Z',C.pink);ellipse(0,0,49,49,C.yellow,true);ellipse(0,0,40,40,C.white,true);line('M0 0 L-2 -24 M0 0 L21 8',C.ink,3);for(let i=0;i<12;i++){const a=i*PI/6;line(`M${Math.cos(a)*32} ${Math.sin(a)*32}L${Math.cos(a)*36} ${Math.sin(a)*36}`,C.ink,1)}line('M-26 41 L-36 52 M26 41 L36 52',C.ink,4);if(t%1<.5){line('M-65 -32 l-11 -9 M-62 -49 l-4 -13 M62 -32 l11 -9 M58 -49 l4 -13',C.ink,2)}})}
function paperList(x,y,s=1,postpone=false){transform(x,y,s,-.08,()=>{paint('M-100 -85 L91 -85 L103 89 L-90 97Z','#f2e3bf');paint('M-19 -92 L24 -92 L24 -67 L-19 -67Z','#c4cfb0',false);text('今日待办',0,-46,22);line('M-72 -23 L73 -23','#baaa8e',1);text('□  下一场雨',0,12,23);if(postpone){line('M-65 15 L74 5','#ca8e81',3);text('明天也行～',1,56,22,'#b77c72')}})}
function sheep(x,y,s,t,n){transform(x,y,s,Math.sin(t*5)*.10,()=>{let jump=Math.abs(Math.sin(t*3))*14;transform(0,-jump,1,0,()=>{for(let i=0;i<6;i++)ellipse(Math.cos(i*PI/3)*24,Math.sin(i*PI/3)*13,19,18,C.white,true);ellipse(34,1,18,21,'#b7aea0',true);ellipse(39,-5,2.8,3,C.ink);line('M-18 22 l-7 16 M14 23 l5 16',C.ink,3)});text(n,0,-70,25,C.deep)})}
function particles(t,kind='rain',n=80){for(let k=0;k<n;k++){let x=rand(k+240)*1280,y=((t*(kind==='rain'?210:30)+rand(k+822)*850)%850)-70;if(kind==='rain'){line(`M${x} ${y} l-5 15`,'rgba(108,157,171,.62)',1.7)}else{ellipse(x,y,1.5,1.5,'#f6edca')}}}
function snail(x,y,s,t){transform(x,y,s,0,()=>{paint('M-41 6 Q-51 -12 -10 -9 L30 -11 Q31 -36 40 -33 Q45 -28 42 -4 Q64 8 32 14 L-30 14Z','#d9caaa');ellipse(-10,-11,25,23,'#d5a28a',true);line('M-10 -10 C-33 -28 15 -36 12 -10 C13 10 -22 6 -16 -10 Q-9 -22 0 -10',C.ink,1.3);line('M35 -29 l-4 -15 M42 -29 l9 -13',C.ink,2);ellipse(30,-45,3,3,C.ink);ellipse(51,-44,3,3,C.ink);paint('M-47 -55 Q-5 -114 40 -57 Q-6 -73 -47 -55Z','#94ab80');line('M-5 -79 L-8 -18','#7b896e',2);})}
function stars(x,y,t){for(let k=0;k<7;k++){let a=k*PI*2/7+t*.4;transform(x+Math.cos(a)*180,y+Math.sin(a)*135,.5,0,()=>line('M-10 0 H10 M0 -10 V10',C.yellow,3))}}
function stage(id,u){
 if(id===0){
 ground(Q);c.save();c.globalAlpha=.85;rainbow(189,414,1.45,.24);c.restore();
 cloud(874+Math.sin(Q)*8,277+Math.sin(Q*1.5)*8,.89,'sleep',-.05,'idle');
 paperList(1010,475,.49);bird(150+u*30,171,.7,Q);bird(270+u*20,200,.5,Q+.5);
 text('一朵云的「明天再说」',310,276,21,C.deep);text('再等五分钟',306,345,60,C.ink,'center',620);line('M112 392 Q295 405 508 388','#c59a79',1.6);
 text('总想拖延的云，终于决定下一场雨',309,438,20);text('原创手绘漫画动画',309,484,16,'#8b8b79');
 let z=(Q*.4)%1;text('z',1028,180-z*34,25,'#8b9e9e');text('Z',1058,155-z*34,32,'#8b9e9e');
 caption('天空里，住着一朵总说「再等等」的小云。');
 }
 if(id===1){
 wash(660,315,640,290,'#adcbd2',.35);wash(910,280,190,130,C.yellow,.17);
 let wake=ease((u-1)/.7);cloud(495,332,1.21,wake<.5?'sleep':'happy',-.04,'hold');
 clock(244,453,.8,u);paperList(920,317,1.24,u>2.7);
 if(u>3.4)bubble('五分钟就好。',491,142,255);
 if(u>2.7){transform(1073,400,.7,Math.sin(u*3)*.1,()=>{paint('M-15 -8 L68 -47 L76 -34 L-8 5 L-25 8Z',C.yellow);line('M-25 8 L-14 -7','#6d665b',3)})}
 caption(u<2.7?'今天的任务很简单：下一场雨。':'可是……先休息五分钟吧。');
 }
 if(id===2){
 wash(650,295,600,320,'#c6d9d9',.35);cloud(926,336,.91,'happy',.06,'idle');
 for(let i=0;i<3;i++){let x=220+i*201-((u*35)%80);sheep(x,389+Math.sin(i)*30,.82,Q+i,i+1)}
 line('M65 468 Q500 489 729 459','#bac4b4',1.6);bubble('先数完这些羊……',935,151,295);
 text('1，2，3……',459,205,31,C.deep);caption('它给自己找了一点点小事。');
 }
 if(id===3){
 wash(650,320,600,300,'#abc9d0',.25);cloud(362,343,.92,'happy',-.11,'reach');
 rainbow(874,461,1.54,.82);let f=Math.sin(Q*3)*9;
 transform(795,330+f,1,0,()=>{paint('M-40 -4 Q-98 -71 -103 -11 Q-93 20 -40 -4 Q10 -61 34 -13 Q38 24 -40 -4Z',C.pink);ellipse(-38,-3,12,14,C.yellow,true);paint('M-40 7 L-66 77 L-38 62 L-20 76 L-21 9Z',C.pink)});
 line('M529 424 Q660 295 756 333',C.ink,2);bubble('彩虹也要系整齐！',345,148,295);
 butterfly(1115,215,.9,Q);caption('忙了半天，一滴雨也没下。');
 }
 if(id===4){
 wash(650,320,600,300,'#a2c4ce',.35);
 const recoil=pulse(u,2.2,3.7);cloud(589,308,1.18,'scared',-.04-recoil*.07,'hold',{sx:1+.08*recoil,sy:1-.10*recoil});
 drop(588,478+Math.sin(Q*3)*9,.65,true);line('M516 409 Q520 470 570 476 M658 407 Q659 469 605 476',C.ink,2);
 if(u<2.5)bubble('万一……下不好呢？',933,220,295);
 else{bubble('要不，明天？',940,220,240);clock(231,252,.54,u)}
 for(let k=0;k<4;k++)line(`M${395+k*12} 170 l-8 -${18+k*3}`,'#9ca4a1',1.5);
 caption('其实，它只是有一点点害怕：第一滴，该怎么下？');
 }
 if(id===5){
 ground(Q);c.save();c.translate(-210,-280);c.scale(1.65,1.65);flower(588,530,1.22,false,0);c.restore();
 cloud(1000,159,.37,'sad',.1,'idle');
 for(let i=0;i<3;i++)paint(`M${80+i*100} 571 l33 -9 16 13 29 -12`,'#c7b38c',false);
 butterfly(285+u*6,293+Math.sin(Q)*12,.75,Q);
 if(u>1)bubble('一小滴，也可以呀。',394,267,315);
 caption('地上的小花，已经等了好久。');
 }
 if(id===6){
 wash(650,310,610,300,'#a9c8cf',.34);wash(540,300,265,190,'#f2cd9c',.22);
 const a=ease(u/4);cloud(633,321,1.40,u<2?'sad':'happy',mix(.09,-.04,a),'hug');
 if(u<2.3){let k=ease(u/2.3);paperList(266,415,.62*(1-k*.3),true);}
 else{let v=u-2.3;transform(268+v*160,400-v*50,.75,-v*.15,()=>{paint('M-55 -9 L68 -36 L-1 25 L-9 2Z','#efe4c7');line('M-9 2 L68 -36',C.ink,1);});}
 if(u>2)bubble('那就……从一滴开始。',641,124,375);
 caption('原来，不用等到万事俱备。');
 }
 if(id===7){
 wash(650,290,600,300,'#9ebfca',.4);
 const v=ease((u-.3)/1.4),release=ease((u-2.1)/1.2);
 cloud(641,240,1.02,u<1.5?'scared':'joy',0,u<2?'hold':'spread',{sx:1+.08*Math.sin(v*PI),sy:1+.13*Math.sin(v*PI)});
 drop(641,415+release*230,.55+release*.2,true);
 if(u<2.1)text('吸——',960,316,35,C.deep);
 else{line('M600 420 v38 M681 420 v38','#9db9bd',2);text('就现在！',933,306,36,C.deep);}
 caption('小云吸了一大口气，松开了手。');
 }
 if(id===8){
 wash(650,300,580,300,'#b6d1d3',.28);
 const y=mix(168,407,ease(u/1.55));
 if(u<1.62){drop(640,y,1.2,true,Math.sin(u*3)*.06);line(`M609 ${y-80} v-43 M674 ${y-96} v-32`,'#b8cbca',2)}
 cup(640,442,2.3,u>1.62?ease((u-1.62)/.5):0);
 if(u>1.62){const p=clamp((u-1.62)/1.4);for(let k=0;k<6;k++){let a=k*PI/5+PI;ellipse(640+Math.cos(a)*p*115,430+Math.sin(a)*p*95+p*p*25,3,6,'#9cbfc8')}c.save();c.globalAlpha=1-p;for(let i=0;i<3;i++){c.beginPath();c.ellipse(640,424,15+p*68+i*14,4+p*8,0,0,2*PI);c.strokeStyle=C.deep;c.lineWidth=1.4;c.stroke()}c.restore();text('叮咚。',885,276,39,C.deep);}
 caption('第一滴雨，轻轻落进了小花的杯子。');
 }
 if(id===9){
 ground(Q,1);rainbow(1037,414,1.23,ease(u/3)*.5);
 let b=1+.035*Math.sin(Q*5);cloud(639,224,b,'joy',Math.sin(Q*3)*.035,'spread');
 particles(Q,'rain',125);
 flower(640,612,1.02,true,1);flower(354,613,.62,true,1);flower(921,602,.70,true,1);
 for(let k=0;k<15;k++){let xx=rand(k+440)*1280;let yy=586+rand(k+881)*91;flower(xx,yy,.24+rand(k+881)*.15,true,1)}
 snail(195+u*9,600,.83,Q);
 for(let k=0;k<8;k++){let xx=rand(k+10)*1280,yy=620+rand(k+44)*45;let p=(Q*1.5+k*.17)%1;c.save();c.globalAlpha=(1-p)*.6;c.beginPath();c.ellipse(xx,yy,8+p*15,2+p*5,0,0,2*PI);c.strokeStyle=C.deep;c.lineWidth=1.1;c.stroke();c.restore()}
 if(u>3.5){butterfly(815+Math.sin(Q)*50,403+Math.sin(Q*3)*15,.8,Q);}
 caption(u<4?'接着，第二滴、第三滴……整个世界都笑了。':'它终于知道：自己也能带来一点点美好。');
 }
 if(id===10){
 ground(Q,1);rainbow(886,453,2.18,.62);particles(Q,'spark',35);
 cloud(918,266,.73,u<2.4?'sleep':'joy',-.03,u<2.4?'idle':'spread');
 flower(665,598,.78,true,1);snail(273,605,.69,Q);butterfly(500+Math.sin(Q)*30,242,.8,Q);
 text('勇敢，',342,303,43);text('有时只是一小滴。',342,369,43);line('M132 415 Q325 429 553 413','#c8ac82',1.4);
 text('《再等五分钟》',342,470,20,C.deep);text('献给每一个准备开始的你',342,511,18,'#858b76');
 if(u>2.4){bubble('今天，就今天！',975,110,256);for(let k=0;k<5;k++)drop(818+k*48,405+((Q*45+k*23)%150),.15,false)}
 caption('后来，小云还是爱赖床。但它学会了：现在，就下一场雨。');
 }
}
function border(){c.save();c.strokeStyle='rgba(130,129,106,.26)';c.lineWidth=1;line('M30 34 Q640 30 1250 35 L1247 635 Q650 641 31 636Z','rgba(130,129,106,.22)',1);c.restore()}
window.viscraft={ready:async()=>{prepareSurface(innerWidth,innerHeight);await Promise.all([430,620].map(w=>document.fonts.load(w+' 30px Story')));await document.fonts.ready},render:({time,width,height,params={}})=>{prepareSurface(width,height);T=time+(params.start||0);Q=Math.floor(T*12)/12;const scale=Math.min(width/W,height/H);c.setTransform(1,0,0,1,0,0);c.globalAlpha=1;c.fillStyle=C.paper;c.fillRect(0,0,width,height);c.setTransform(scale,0,0,scale,(width-W*scale)/2,(height-H*scale)/2);c.drawImage(paper,0,0,W,H);c.save();c.beginPath();c.rect(32,33,1216,605);c.clip();const id=params.scene||0;const lens=[1+ease(time/5)*.018,1+ease(time/6)*.03,1.015,1.01,1+ease(time/6)*.025,1+ease(time/6)*.045,1+ease(time/5)*.055,1.025,1.01,1.09-ease(time/9)*.09,1.03-ease(time/7)*.03][id];c.translate(640,330);c.scale(lens,lens);if(id===4)c.rotate(Math.sin(time*1.3)*.007);c.translate(-640,-330);stage(id,time);c.restore();captionForOutside(id,time);border();}};
function captionForOutside(id,u){const captions=[['天空里，住着一朵总说「再等等」的小云。'],[u<2.7?'今天的任务很简单：下一场雨。':'可是……先休息五分钟吧。'],['它给自己找了一点点小事。'],['忙了半天，一滴雨也没下。'],['其实，它只是有一点点害怕：第一滴，该怎么下？'],['地上的小花，已经等了好久。'],['原来，不用等到万事俱备。'],['小云吸了一大口气，松开了手。'],['第一滴雨，轻轻落进了小花的杯子。'],[u<4?'接着，第二滴、第三滴……整个世界都笑了。':'它终于知道：自己也能带来一点点美好。'],['后来，小云还是爱赖床。但它学会了：现在，就下一场雨。']];caption(captions[id][0])}
