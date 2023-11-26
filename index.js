import express from "express";
import bodyParser from "body-parser";
import makeStruct from 'makestruct';
import axios from "axios";

const app = express();
const port = 3000;

const trades = [];
const asset = new makeStruct("name, quantity, event, date, time, price");

const API_URL = "https://www.alphavantage.co/";
const yourAPIToken = "3IVLRION3GBCV7M4";

function getRoundedDate(minutes, d=new Date()) {

    let ms = 1000 * 60 * minutes; // convert minutes to ms
    let roundedDate = new Date(Math.round(d.getTime() / ms) * ms);
  
    return roundedDate
}

app.use(bodyParser.urlencoded({ extended: true }));
app.get("/", (req, res) => {
    res.render("index.ejs", {data: trades});
  });
  
app.post("/asset", async (req, res) => {
    try {
        const eventDate = req.body["aDate"];
        const eventTime = req.body["aTime"];
        const eventSymbol = req.body["aName"];
        const result = await 
            axios.get(`https://www.alphavantage.co/query?function=TIME_SERIES_INTRADAY&symbol=${eventSymbol}&interval=5min&month=${eventDate.slice(0,7)}&apikey=${yourAPIToken}`);

        const eventPrice = result.data['Time Series (5min)'][eventDate + " " + eventTime + ":00"]['1. open'];
        const newAsset = new asset(eventSymbol, req.body["aQuantity"],req.body["aEvent"], eventDate, eventTime, eventPrice);
        trades.push(newAsset);
        res.render("addasset.ejs", 
        { addedAssetName: newAsset.name,
            addedAssetEvent: newAsset.event, 
            addedAssetQuantity: newAsset.quantity,
            addedAssetDate: newAsset.date,
            addedAssetTime: newAsset.time,
            addedAssetPrice: newAsset.price
        });
      } catch (error) {
        console.log(res.statusCode)
      }
});

app.post("/", (req, res) => {
    res.render("index.ejs", {data: trades});
})

app.listen(port, () => {
    console.log(`Listening on port ${port}`);
  });