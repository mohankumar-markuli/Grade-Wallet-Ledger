const express=require('express');
const authenticateToken=require('../middleware/auth.middleware');
const {requireIdempotencyKey}=require('../middleware/require-idempotency-key.middleware');
const {createWallet}=require('../repositories/wallet.repository');
const router=express.Router();
router.post('/:id/wallets',authenticateToken,requireIdempotencyKey,async(req,res,next)=>{
    try{
        if(String(req.user.id)!==String(req.params.id)) return res.status(404).json({error:{code:'USER_NOT_FOUND',message:'User not found.'}});
        const wallet=await createWallet({userId:req.user.id,idempotencyKey:req.idempotencyKey});
        return res.status(201).json({data:wallet});
    }catch(error){return next(error);}
});
module.exports=router;
