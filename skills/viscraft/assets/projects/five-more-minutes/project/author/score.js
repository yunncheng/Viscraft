// Packaging adaptation: render length uses the current samples argument; synthesis is unchanged.
/* Original 60-second score: a six-note hesitation becomes a rain waltz.
   Chamber toy orchestra: felt pluck, glass bell, breathy flute, soft reed bass.
   Foley shares the film's exact event clock. No stock recordings. */
window.viscraftSound={render:async({sampleRate,channels,samples,params={}})=>{
 const sr=sampleRate,ctx=new OfflineAudioContext(channels,samples,sr),dest=ctx.destination;
 const music=ctx.createGain(),fx=ctx.createGain();music.gain.value=.63;fx.gain.value=.75;music.connect(dest);fx.connect(dest);
 const r=x=>{let v=Math.sin(x*127.1+311.7)*43758.5453;return v-Math.floor(v)};
 const hz=m=>440*Math.pow(2,(m-69)/12);
 function buffer(t,d,fn,gain=.2,pan=0,bus=music){if(t<0||t>=60)return;const len=Math.ceil(Math.min(d,60-t)*sr),b=ctx.createBuffer(1,len,sr),a=b.getChannelData(0);for(let i=0;i<len;i++)a[i]=fn(i/sr,i)*gain;const s=ctx.createBufferSource();s.buffer=b;const p=ctx.createStereoPanner();p.pan.value=pan;s.connect(p);p.connect(bus);s.start(t);}
 function note(t,m,d=.6,kind='pluck',v=.2,pan=0){const f=hz(m);if(kind==='pluck'){
  const size=Math.round(sr/f);let a=new Float32Array(size);for(let i=0;i<size;i++)a[i]=(r(i+m*23+t*31)*2-1)*.6;
  buffer(t,d,(q,i)=>{let j=i%size;const z=a[j];a[j]=.496*(a[j]+a[(j+1)%size]);return z*Math.min(q/.007,1)*Math.exp(-q*.9);},v,pan);
 }else if(kind==='bell')buffer(t,d,(q)=>Math.sin(2*Math.PI*f*q)*Math.exp(-q*3.1)+.28*Math.sin(2*Math.PI*f*2.76*q)*Math.exp(-q*6)+.08*Math.sin(2*Math.PI*f*5.4*q)*Math.exp(-q*14),v,pan);
 else if(kind==='flute')buffer(t,d,(q,i)=>{let env=Math.min(q/.07,1)*Math.min((d-q)/.15,1);let ph=2*Math.PI*f*q+.012*Math.sin(q*2*Math.PI*5);return env*(.69*Math.sin(ph)+.13*Math.sin(ph*2)+.04*Math.sin(ph*3)+.035*(r(i+69)-.5))},v,pan);
 else if(kind==='reed')buffer(t,d,(q)=>{const env=Math.min(q/.045,1)*Math.min((d-q)/.1,1);return env*(.6*Math.sin(2*Math.PI*f*q)+.12*Math.sin(6*Math.PI*f*q)+.035*Math.sin(10*Math.PI*f*q))},v,pan);
 else if(kind==='pad')buffer(t,d,(q)=>{let env=Math.min(q/.3,1)*Math.min((d-q)/.5,1);return env*(.45*Math.sin(2*Math.PI*f*q)+.13*Math.sin(2*Math.PI*f*1.003*q))},v,pan);
 }
 function chime(t,m,v=.18){note(t,m,2,'bell',v,.12);note(t+.09,m+12,1.1,'bell',v*.24,-.2)}
 const motif=[76,79,81,79,76,74];
 // 0–19 seconds: a slightly lopsided 6/8 daydream, two playful postponements.
 for(let bar=0;bar<9;bar++){let at=.35+bar*2.05;if(at>18)break;const root=[48,53,55][bar%3];note(at,root,1.3,'pluck',.25,-.15);note(at+.95,root+7,1,'pluck',.14,.18);
  motif.forEach((m,j)=>{let tm=at+j*.29;if(tm<18.7)note(tm,m+(bar%3===1?-2:0),.65,'pluck',j===0?.36:.25,Math.sin(j)*.25)});
  if(bar%2===1)note(at+1.78,86,.7,'bell',.09,.3);
 }
 // Counting sheep: tiny wood taps and a clumsy rising flute answer.
 for(let k=0;k<6;k++)note(11.25+k*.52,[72,74,76,79,81,79][k],.24,'reed',.10,-.3+k*.1);
 [15.4,16.55,17.7].forEach((t,i)=>chime(t,79+i*2,.09));
 // Fear: little detached reed questions, with room for the trembling cloud.
 for(let j=0;j<3;j++){let at=19.35+j*1.8;note(at,57-j, .38,'reed',.10,-.12);note(at+.45,69-j,.35,'pluck',.24,.12);note(at+.88,67-j,.35,'pluck',.20,.2)}
 // Flower: voices withdraw. The same motif is stretched into a tender answer.
 [0,1,2].forEach((b)=>{let t=25.25+b*1.9;note(t,[53,48,55][b],2.1,'pad',.095,-.15);note(t+.1,[76,74,72][b],1.5,'flute',.115,.12);note(t+.82,[79,76,74][b],1.1,'bell',.065,-.3)});
 // Courage: rising broken chords; no new theme, only a new willingness.
 for(let k=0;k<12;k++){let t=31.15+k*.38;note(t,[60,64,67,72,64,67,72,76,67,72,76,79][k],1.2,'pluck',.23,(k%3-1)*.2)}
 note(31.3,72,2.1,'flute',.11);note(33.5,76,1.6,'flute',.11);note(35.1,79,.75,'flute',.1);
 for(let k=0;k<8;k++){let t=36.1+k*.35;note(t,[60,64,67,72,76,79,81,84][k],.6,'pluck',.16+k*.006,0)}
 // A written rest: 39.3–41.62. The first drop is heard by itself.
 chime(41.62,88,.34);note(42.1,76,1.6,'bell',.09,-.2);note(42.8,79,1.2,'bell',.1,.25);
 // Rain waltz: full motif, plucked bass and airy flute; a gentle 3/4 skip.
 for(let b=0;b<6;b++){let at=44+b*1.5;let roots=[48,53,55,52,53,55];note(at,roots[b],1.25,'pluck',.35,-.18);for(let j=1;j<3;j++){note(at+j*.5,roots[b]+12,.9,'pluck',.14,.1);note(at+j*.5,roots[b]+19,.9,'pluck',.12,.2)}
  motif.forEach((m,j)=>note(at+j*.23,m+(b===3?-2:0),.7,'flute',.11,(j-2.5)*.08));if(b%2===0)chime(at+.75,88,.06);
 }
 // Reprise and a real cadence, leaving a resonant tail before the last frame.
 [76,79,81,79,76,72].forEach((m,j)=>note(53.2+j*.58,m,1.4,'bell',.12,.1));
 note(53.2,48,2.6,'pad',.08,-.2);note(55.7,53,1.6,'pad',.07,.2);note(57.2,55,1,'pluck',.18,-.1);
 [60,64,67,72].forEach((m,j)=>note(58.05+j*.07,m,1.7-j*.07,'pluck',.18,(j-1.5)*.12));note(58.4,84,1.4,'bell',.08);
 // Material Foley: handbell clock, paper shuffling, breath, wind and water.
 function noise(t,d,v,type='paper',pan=0){let last=0;buffer(t,d,(q,i)=>{let n=r(i+t*1234)*2-1;let low=.88*last+.12*n;last=low;let env=Math.sin(Math.PI*q/d);if(type==='paper')return(n-low)*env*(.45+.3*Math.sin(q*70));if(type==='wind')return low*env;return low*env*.6},v,pan,fx)}
 [.6,5.18,5.52,6.02,21.68,22.08].forEach((t)=>{for(let k=0;k<3;k++)buffer(t+k*.035,.16,(q)=>Math.sin(2*Math.PI*1810*q)*Math.exp(-q*28)+.3*Math.sin(2*Math.PI*2747*q)*Math.exp(-q*45),.025,-.35,fx)});
 noise(7.65,.45,.12);noise(8.1,.65,.08);noise(10.7,.5,.04,'wind');noise(14.8,.5,.07,'wind');noise(18.7,.4,.075,'wind');
 noise(33.3,.45,.09);noise(33.7,1.9,.1,'wind',-.2);noise(36.2,1.15,.14,'wind');noise(38.1,1.1,.08,'wind');
 function water(t,v=.10,pan=0){buffer(t,.23,(q,i)=>{let ph=2*Math.PI*(1250*q-1800*q*q);return Math.sin(ph)*Math.exp(-q*28)+.12*(r(i+3)-.5)*Math.exp(-q*40)},v,pan,fx)}
 water(41.62,.25);water(42.0,.045,-.18);water(42.4,.03,.15);
 for(let k=0;k<120;k++){let t=44+r(k+80)*9;water(t,.025+r(k+17)*.035,r(k+41)*1.6-.8)}
 // Continuous rain is an actual filtered noise bed; the close drops remain separate.
 let last=0;buffer(44,9.6,(q,i)=>{const n=r(i+50000)*2-1;last=.96*last+.04*n;const env=Math.min(q/1.5,1)*Math.min((9.6-q)/1.3,1);return(n*.27+last)*env*(.8+.2*Math.sin(q*.7))},.075,0,fx);
 [56.0,56.5,57.0].forEach((t,i)=>water(t,.045+i*.008,(i-1)*.12));
 const out=await ctx.startRendering();return{channels:Array.from({length:channels},(_,i)=>out.getChannelData(i))};
}};
