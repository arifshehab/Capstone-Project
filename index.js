import express from "express";
import bodyParser from "body-parser";
import makestruct from "makestruct";
import yahooFinance from 'yahoo-finance2';

const app = express();
const port = 3000;

const trades = [];
const asset = new makestruct("name, quantity, event, date");

app.use(bodyParser.urlencoded({ extended: true }));
app.get("/", (req, res) => {
    res.render("index.ejs", {data: trades});
  });
  
app.post("/asset", (req, res) => {
    
    const newAsset = new asset(req.body["aName"], req.body["aQuantity"],req.body["aEvent"], req.body["aDate"]);
    trades.push(newAsset);
    res.render("addasset.ejs", { addedAssetName: newAsset.name, addedAssetEvent: newAsset.event, addedAssetQuantity : newAsset.quantity, addedAssetDate : newAsset.date});
});

app.post("/", (req, res) => {
    res.render("index.ejs", {data: trades});
})

app.listen(port, () => {
    console.log(`Listening on port ${port}`);
  });