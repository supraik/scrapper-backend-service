
const express = require('express');
const router = express.Router();

const {auth} = require("../middlewares/auth");
const {getSearch,addProducts,removeProducts,getDashboard,getHistory}=require("../controllers/allControllers") 

router.use(auth);

router.get("/search",getSearch);
router.get("/add",addProducts);
router.get("/remove",removeProducts);
router.get("/dashboard",getDashboard);
router.get("/history",getHistory);

module.exports = router;
