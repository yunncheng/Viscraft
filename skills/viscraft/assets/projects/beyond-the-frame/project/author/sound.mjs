// Packaging adaptation: use the current sample-count argument; synthesis is unchanged.
// An original, structured chamber miniature and synchronized illustrative foley.
// Music: toy-piano/pizzicato curiosity -> a breath at the tear -> warm felt-piano harmony.
const clamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,x));
const sm=(a,b,t)=>{let p=clamp((t-a)/(b-a));return p*p*(3-2*p)};
const midi=n=>440*2**((n-69)/12);
window.viscraftSound={render:({sampleRate,channels,samples,params,seed})=>{
 const L=new Float32Array(samples),R=new Float32Array(samples),sr=sampleRate;
 const add=(start,dur,fn,amp=1,pan=0)=>{const n=Math.min(samples-Math.floor(start*sr),Math.ceil(dur*sr)),st=Math.floor(start*sr),l=Math.cos((pan+1)*Math.PI/4),r=Math.sin((pan+1)*Math.PI/4);for(let i=0;i<n;i++){if(st+i<0)continue;const v=fn(i/sr,i)*amp;L[st+i]+=v*l;R[st+i]+=v*r}};
 let z=(seed||6931)>>>0;const rnd=()=>{z^=z<<13;z^=z>>>17;z^=z<<5;return (z>>>0)/4294967296*2-1};
 function piano(at,n,dur,amp=.12,pan=0){const f=midi(n);add(at,dur,(t)=>{const attack=1-Math.exp(-t*180);let s=0;for(let k=1;k<=5;k++)s+=Math.sin(2*Math.PI*f*k*(1+k*k*.00008)*t)*Math.exp(-t*(1.3+k*.9))/(k*k*.7);return attack*s*(1-sm(dur-.65,dur,t));},amp,pan)}
 function pluck(at,n,amp=.11){const f=midi(n);add(at,.72,t=>Math.sin(2*Math.PI*f*t)*Math.exp(-t*9)*(1-Math.exp(-t*400))+.22*Math.sin(2*Math.PI*f*2.01*t)*Math.exp(-t*15),amp,(n%5-2)*.12)}
 const motif=[72,76,79,76,74,77,81,79,76,79,84,81,77,76,74,72];
 motif.forEach((n,i)=>pluck(.30+i*.39,n,.115*(i>11?.85:1)));
 [48,53,55,48].forEach((n,i)=>pluck(.30+i*1.56,n,.16));
 // Anticipation: closer short notes, then a real rest around front-wheel contact.
 [76,79,84].forEach((n,i)=>pluck(6.55+i*.21,n,.10));
 const chords=[[48,55,60,64],[45,52,57,60],[41,48,53,57],[43,50,55,59],[48,55,60,64]];
 [8.23,11.47,14.71,17.95,21.1].forEach((at,i)=>{chords[i].forEach((n,k)=>piano(at+k*.065,n,4.6,.080,k%2?.25:-.25));});
 [[8.55,76],[9.60,79],[10.75,84],[12.05,81],[13.3,79],[15.0,77],[16.2,76],[18.3,74],[19.6,76],[21.35,72]].forEach(([at,n])=>piano(at,n,3.1,.105,.10));
 // Quiet sustained harmonic voice enters only in the photographic world.
 for(let j=0;j<5;j++){const at=8.6+j*3.1;const notes=chords[j];for(let k=0;k<3;k++){const f=midi(notes[k]+12);add(at,4.0,t=>{const env=sm(0,.7,t)*(1-sm(2.7,4,t));return (Math.sin(2*Math.PI*f*t)+.19*Math.sin(2*Math.PI*f*2.001*t))*.026*env},1,(k-1)*.45)}}
 // Small wood clicks and chain ticks are tied to the authored pedaling clock.
 for(let at=.14;at<7.5;at+=.26){const f=900+at*18;add(at,.05,t=>Math.sin(2*Math.PI*f*t)*Math.exp(-t*110),.026,-.15)}
 // A discrete tactile paper rip at the same frame as the front-wheel contact.
 let low=0;const ripNoise=Float32Array.from({length:Math.ceil(1.15*sr)},()=>{low=.83*low+.17*rnd();return low});
 add(7.583333,1.15,(t,i)=>ripNoise[i]*(Math.exp(-t*5)*.60+.20*Math.exp(-(((t-.18)/.035)**2))+.18*Math.exp(-(((t-.41)/.08)**2)))*(1-sm(.83,1.15,t)),.48,.05);
 [7.66,7.82,8.04,8.21,8.46].forEach((at,i)=>{const f=midi(88+i*3);add(at,1.2,t=>(Math.sin(2*Math.PI*f*t)+.3*Math.sin(2*Math.PI*f*2.71*t))*Math.exp(-t*5)*(1-Math.exp(-t*250)),.045,(i-2)*.32)});
 // Filtered independent stereo noise creates a gentle surf/wind bed, not a field recording.
 let nL=0,nR=0,slowL=0,slowR=0;
 for(let i=0;i<samples;i++){const t=i/sr,gate=sm(7.3,9.2,t),tail=1-sm(24.2,25,t);nL=.87*nL+.13*rnd();nR=.87*nR+.13*rnd();slowL=.997*slowL+.003*rnd();slowR=.997*slowR+.003*rnd();const swell=.52+.24*Math.sin(t*1.43)+.10*Math.sin(t*3.17);const a=gate*tail*.14*swell;L[i]+=(nL+slowL*.9)*a;R[i]+=(nR+slowR*.9)*a;}
 // Fleeting spray accents when the wheel crosses shallow water; subtle, no thunderous splash.
 [9.6,11.1,13.4,15.3].forEach((at,j)=>{let lp=0;add(at,.55,t=>{lp=.74*lp+.26*rnd();return lp*Math.exp(-t*8)*(1-Math.exp(-t*70))},.12,j%2?.25:-.2)});
 // A little reflective space after the stop; only distant sea and the last resonance remain.
 const DL=Math.round(.139*sr),DR=Math.round(.183*sr);for(let i=0;i<samples;i++){if(i>=DL)L[i]+=.17*R[i-DL];if(i>=DR)R[i]+=.14*L[i-DR];const t=i/sr,fade=sm(0,.12,t)*(1-sm(24.2,25,t));L[i]*=fade;R[i]*=fade;}
 let peak=0;for(let i=0;i<samples;i++)peak=Math.max(peak,Math.abs(L[i]),Math.abs(R[i]));if(peak>.85){for(let i=0;i<samples;i++){L[i]*=.85/peak;R[i]*=.85/peak}}
 return {channels:channels===1?[Float32Array.from(L,(v,i)=>(v+R[i])*.5)]:[L,R]};
}};
