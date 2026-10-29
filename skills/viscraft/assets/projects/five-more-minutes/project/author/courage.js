/* A shot-specific performance refinement: hands meet the actual droplet before release. */
const baseStage=stage;
stage=function(id,u){
 if(id!==7)return baseStage(id,u);
 wash(650,290,600,300,'#9ebfca',.4);
 const inhale=ease((u-.3)/1.4),release=ease((u-2.1)/1.2);
 const lettingGo=u>=2.1;
 cloud(641,240,1.02,u<1.5?'scared':'joy',0,lettingGo?'spread':'none',{
  sx:1+.08*Math.sin(inhale*PI),sy:1+.13*Math.sin(inhale*PI)
 });
 if(!lettingGo){
  arm(495,256,451,344,628,349);
  arm(790,255,830,344,654,349);
 }
 drop(641,352+release*293,.55+release*.2,true);
 if(!lettingGo)text('吸——',960,316,35,C.deep);
 else{line('M600 377 v38 M681 377 v38','#9db9bd',2);text('就现在！',933,306,36,C.deep);}
};
