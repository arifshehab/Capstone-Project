import express from "express";
import bodyParser from "body-parser";
import makestruct from "makestruct";

const app = express();
const port = 3000;

const trades = [];
const asset = new makestruct("name, position, event, date");

app.use(bodyParser.urlencoded({ extended: true }));
app.get("/", (req, res) => {
    res.render("index.ejs");
  });
  
app.post("/asset", (req, res) => {
    
    const newAsset = new asset(req.body["aName"], req.body["aPos"],req.body["aEvent"], req.body["aDate"]);
    trades.push(newAsset);
    res.render("addasset.ejs", { addedAssetName: newAsset.name, addedAssetEvent: newAsset.event, addedAssetPos : newAsset.position, addedAssetDate : newAsset.date});
});  

app.listen(port, () => {
    console.log(`Listening on port ${port}`);
  });