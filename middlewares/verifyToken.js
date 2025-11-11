const { verify } = require("crypto");
const jwt = require("jsonwebtoken");


//Verify Token
function verifyToken (req,res,next) {
    const token = req.headers.token;
    if(token){
        try {
            const decoded = jwt.verify(token , process.env.JWT_SECRET_KEY);
            req.user = decoded;
            next();
        } catch (error) {
            res.status(401).json({message: "invalid token"});
        }
    } else {
        res.status(401).json({message: "no token provided"});
    }
}


// Verify Token And Authorize The User
function verifyTokenAndAuthorization(req,res,next){
    verifyToken(req,res, ()=>{
        if(req.user.id === req.params.id ||req.user.isAdmin){
            next();
        } else {
            return res.status(403).json({message: "You're not allowed :)  "})
        }
    })
}

// Verify Token And Admin
function verifyTokenAndAdmin (req,res,next) {
    verifyToken(req,res, ()=> {
        if(req.user.isAdmin){
            next();
        }   else {
            return res.status(403).json({message: "You're not allowed , Only Admin Allowed "})
        }
    })
}

module.exports = {
    verifyToken,
    verifyTokenAndAuthorization,
    verifyTokenAndAdmin
}