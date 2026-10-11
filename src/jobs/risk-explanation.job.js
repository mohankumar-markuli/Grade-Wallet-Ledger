const pool=require('../config/db');
const {createLlmProvider}=require('../providers/llm-provider');
const provider=createLlmProvider();
async function runNightlyRiskExplanations({now=new Date(),logger=console}={}){
    const end=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()));
    const start=new Date(end.getTime()-86400000);
    const flags=(await pool.query(`SELECT flag.id,flag.rule_code,flag.details,flag.created_at,flag.account_id AS risk_account_id,transfer.id AS transfer_id,transfer.description,transfer.amount_paise,transfer.status,transfer.from_account_id,transfer.to_account_id FROM risk_flags flag JOIN transfers transfer ON transfer.id=flag.transfer_id WHERE flag.created_at >= $1 AND flag.created_at < $2 AND flag.explanation IS NULL ORDER BY flag.id`,[start.toISOString(),end.toISOString()])).rows;
    let explained=0;
    for(const flag of flags){
        const recent=(await pool.query(`SELECT id,transfer_type,amount_paise,status,description,created_at,from_account_id,to_account_id FROM transfers WHERE from_account_id=$1 OR to_account_id=$1 ORDER BY created_at DESC,id DESC LIMIT 10`,[flag.risk_account_id])).rows;
        try{
            const result=await provider.explainRisk({rule:{code:flag.rule_code,details:flag.details},transfer:{id:String(flag.transfer_id),amountPaise:String(flag.amount_paise),status:flag.status,note:flag.description,createdAt:flag.created_at},recentTransfers:recent.map(row=>({id:String(row.id),type:row.transfer_type,amountPaise:String(row.amount_paise),status:row.status,note:row.description,createdAt:row.created_at}))});
            const sentenceCount = typeof result?.explanation === 'string'
                ? result.explanation.trim().split(/[.!?]+(?:\s|$)/).filter(Boolean).length : 0;
            if(!result||typeof result.explanation!=='string'||!result.explanation.trim()||sentenceCount!==2||!['likely_ok','review','likely_fraud'].includes(result.label)) throw new Error('Invalid structured explanation.');
            await pool.query('UPDATE risk_flags SET explanation=$1,explanation_label=$2,explained_at=NOW() WHERE id=$3 AND explanation IS NULL',[result.explanation.trim().slice(0,1000),result.label,flag.id]);
            explained++;
        }catch(error){logger.error(`Could not explain risk flag ${flag.id}:`,error.message);}
    }
    return {examined:flags.length,explained};
}
module.exports={runNightlyRiskExplanations};
