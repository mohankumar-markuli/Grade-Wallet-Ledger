const crypto = require('node:crypto');
const pool = require('../config/db');
function fail(message,status,code){return Object.assign(new Error(message),{status,code});}
async function withdrawFromWallet({walletId,userId,amountPaise,idempotencyKey}){
    const amount=typeof amountPaise==='string'
        ? amountPaise
        : Number.isSafeInteger(amountPaise) ? String(amountPaise) : '';
    if(!/^[1-9]\d*$/.test(amount)||BigInt(amount)>9223372036854775807n) throw fail('amountPaise must be a positive integer.',400,'VALIDATION_ERROR');
    const client=await pool.connect();
    try{
        await client.query('BEGIN');
        const walletResult=await client.query("SELECT id,user_id,balance_paise,status,currency FROM accounts WHERE id=$1 AND user_id=$2 AND account_type='wallet' FOR UPDATE",[walletId,userId]);
        const wallet=walletResult.rows[0]; if(!wallet) throw fail('Wallet not found.',404,'WALLET_NOT_FOUND');
        const requestHash=crypto.createHash('sha256').update(JSON.stringify({operation:'withdrawal',walletId:String(wallet.id),amountPaise:amount})).digest('hex');
        const inserted=await client.query('INSERT INTO idempotency_keys (user_id,idempotency_key,request_hash) VALUES ($1,$2,$3) ON CONFLICT (user_id,idempotency_key) DO NOTHING RETURNING id',[userId,idempotencyKey,requestHash]);
        if(!inserted.rowCount){const old=(await client.query('SELECT request_hash,response_status,response_body FROM idempotency_keys WHERE user_id=$1 AND idempotency_key=$2 FOR UPDATE',[userId,idempotencyKey])).rows[0]; if(!old||old.request_hash!==requestHash) throw fail('This Idempotency-Key was already used for a different request.',422,'IDEMPOTENCY_KEY_REUSED'); if(!old.response_body) throw fail('The original request is incomplete.',409,'IDEMPOTENCY_REQUEST_INCOMPLETE'); await client.query('COMMIT'); return {status:old.response_status,body:old.response_body,replayed:true};}
        const cash=(await client.query("SELECT id FROM accounts WHERE account_type='system' AND account_name='cash_out' AND status='active' LIMIT 1")).rows[0];
        if(!cash) throw new Error('Active cash_out account is not configured.');
        if(BigInt(wallet.balance_paise)<BigInt(amount)) throw fail('Insufficient wallet balance.',422,'INSUFFICIENT_FUNDS');
        const transfer=(await client.query(`INSERT INTO transfers (from_account_id,to_account_id,amount_paise,currency,status,description,completed_at,transfer_type) VALUES ($1,$2,$3,'INR','completed','Wallet withdrawal',NOW(),'withdrawal') RETURNING id,from_account_id,to_account_id,amount_paise,currency,status,created_at,completed_at`,[wallet.id,cash.id,amount])).rows[0];
        await client.query("INSERT INTO ledger_entries (transfer_id,account_id,entry_type,amount_paise) VALUES ($1,$2,'debit',$3),($1,$4,'credit',$3)",[transfer.id,wallet.id,amount,cash.id]);
        const updated=(await client.query('UPDATE accounts SET balance_paise=balance_paise-$1::bigint WHERE id=$2 RETURNING id,balance_paise',[amount,wallet.id])).rows[0];
        await client.query("INSERT INTO transfer_status_audit (transfer_id,old_status,new_status,reason) VALUES ($1,NULL,'completed','Wallet withdrawal')",[transfer.id]);
        const body={data:{transfer,wallet:updated}};
        await client.query("UPDATE idempotency_keys SET response_status=201,response_body=$1::jsonb,transfer_id=$2 WHERE user_id=$3 AND idempotency_key=$4",[JSON.stringify(body),transfer.id,userId,idempotencyKey]);
        await client.query('COMMIT'); return {status:201,body,replayed:false};
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
module.exports={withdrawFromWallet};
