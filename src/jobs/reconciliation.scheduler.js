const {runReconciliation}=require('../repositories/reconciliation.repository');
const {runNightlyRiskExplanations}=require('./risk-explanation.job');
function millisecondsUntilNextUtcMidnight(now){
    const next=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+1,0,0,0,0));
    return Math.max(1,next.getTime()-now.getTime());
}
function scheduleNightlyReconciliation({run=runReconciliation,runRisk=runNightlyRiskExplanations,logger=console,now=()=>new Date(),setTimer=setTimeout,clearTimer=clearTimeout}={}){
    let timer=null;let stopped=false;
    function scheduleNext(){if(stopped)return;timer=setTimer(execute,millisecondsUntilNextUtcMidnight(now()));if(timer&&typeof timer.unref==='function')timer.unref();}
    async function execute(){if(stopped)return;try{const result=await run();if(result.status===409)logger.info('Nightly reconciliation skipped: another run is in progress.');else logger.info('Nightly reconciliation finished.',result.body);const risk=await runRisk({now:now(),logger});logger.info('Nightly risk explanations finished.',risk);}catch(error){logger.error('Nightly scheduled work failed:',error.message);}finally{scheduleNext();}}
    scheduleNext();return function stop(){stopped=true;if(timer!==null)clearTimer(timer);};
}
module.exports={millisecondsUntilNextUtcMidnight,scheduleNightlyReconciliation};
