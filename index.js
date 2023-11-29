import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import Chart from 'chart.js/auto';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from "url";
import dotenv from 'dotenv';
import cheerio from "cheerio";
import puppeteer from "puppeteer";

dotenv.config();

const dbParams = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  ssl: {
    ca: fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'ap-southeast-1-bundle.pem')),
  },
};

const db = new pg.Client(dbParams);

db.connect();

//Variables
const app = express();
const port = process.env.PORT;
const fmpAPIToken = process.env.FMP_TOKEN;

//Middleware
app.use(express.static("public"));
app.use(bodyParser.urlencoded({ extended: true }));

//functions
async function insertJsonData(jsonData, table_name) {
  const keys = Object.keys(jsonData);
  const values = Object.values(jsonData);

  const query = `
    INSERT INTO ${table_name}(${keys.join(', ')})
    VALUES(${values.map((_, index) => `$${index + 1}`).join(', ')})
    RETURNING *;
  `;

  try {
    const result = await db.query(query, values);
    console.log('Data inserted successfully: ' + table_name);
  } catch (error) {
    console.error('Error inserting data: ', error);
  }
};

async function insertUpdateTable(jsonData, table_name, unique) {
  const symbol = jsonData.symbol;

  // Check if the symbol exists in the table
  const existingRecord = await db.query('SELECT * FROM ' + table_name + ' WHERE symbol = $1', [symbol]);

  if (existingRecord.rows.length > 0 && unique) {
    // Symbol already exists, update the record
    const updateKeys = Object.keys(jsonData);
    const updateValues = Object.values(jsonData);

    // Construct the SET part of the UPDATE statement
    const setClause = updateKeys.map((key, index) => `${key} = $${index + 1}`).join(', ');

    const updateQuery = `
      UPDATE ${table_name}
      SET ${setClause}
      WHERE symbol = $${updateKeys.length + 1}
      RETURNING *;
    `;

    try {
      // Add the 'symbol' value to the end of the 'updateValues' array
      updateValues.push(symbol);

      const result = await db.query(updateQuery, updateValues);
      console.log('Data updated successfully:' + table_name);
    } catch (error) {
      console.error('Error updating data:', error);
    }
  } else {
    // Symbol does not exist, insert a new record
    const insertKeys = Object.keys(jsonData);
    const insertValues = Object.values(jsonData);

    const insertQuery = `
      INSERT INTO ${table_name}(${insertKeys.join(', ')})
      VALUES(${insertValues.map((_, index) => `$${index + 1}`).join(', ')})
      RETURNING *;
    `;

    try {
      const result = await db.query(insertQuery, insertValues);
      console.log('Data inserted successfully:' + table_name);
    } catch (error) {
      console.error('Error inserting data:', error);
    }
  }
}

async function calculateCAGR(shortlistTable, historyTable) {
  try {
    const query = `
      SELECT
        h.*,
        i.price,
        POWER((h.quantity * i.price) / h.total_price, (365 / EXTRACT(DAY FROM(NOW() - h.date)))) - 1 AS cagr
        FROM
        ${historyTable} h
      LEFT JOIN
        ${shortlistTable} i ON h.symbol = i.symbol;
    `;

    const result = await db.query(query);
    const data = result.rows;

    console.log('CAGR calculation success');
    return data;
  } catch (error) {
    console.error('Error calculating CAGR:', error);
  }
}

async function calculateWeightedCAGR(shortlistTable, historyTable) {
  try {
    // Calculate CAGR for each trade
    const cagrs = await calculateCAGR(shortlistTable, historyTable);

    // Group data by symbol
    const groupedBySymbol = cagrs.reduce((acc, trade) => {
      if (!acc[trade.symbol]) {
        acc[trade.symbol] = [];
      }
      acc[trade.symbol].push(trade);
      return acc;
    }, {});

    // Calculate weighted average CAGR for each symbol
    const weightedCAGRs = Object.entries(groupedBySymbol).map(([symbol, trades]) => {
      const totalWeight = trades.reduce((sum, trade) => sum + trade.total_price, 0);
      const totalQuantity = trades.reduce((sum, trade) => sum + trade.quantity, 0);
      const weightedCAGR = trades.reduce((weightedSum, trade) => {
        return weightedSum + (trade.cagr * trade.total_price);
      }, 0);

      return {
        symbol,
        weightedCAGR: totalWeight !== 0 ? weightedCAGR / totalWeight : 0,
        totalPurchase: totalWeight,
        totalQuantity: totalQuantity,
      };
    });
    console.log('Weighted CAGRs success');
    return weightedCAGRs;
  } catch (error) {
    console.error('Error calculating weighted CAGRs:', error);
  }
}

async function fetchStockData(shortlistTable, historyTable) {
  try {
    const query = `
      SELECT
        i.*,
        jsonb_agg(jsonb_build_object('platform', h.platform, 'total_trades', h.total_trades, 'total_quantity', h.total_quantity)) AS platforms
      FROM
        ${shortlistTable} i
      LEFT JOIN (
        SELECT
          symbol,
          platform,
          SUM(total_price) AS total_trades,
          SUM(quantity) AS total_quantity
        FROM
          ${historyTable} h
        GROUP BY
          symbol,
          platform
      ) h ON i.symbol = h.symbol
      GROUP BY
        i.symbol;
    `;
    const result = await db.query(query);
    const data = result.rows;

    console.log('Query success', );
    return data;
  } catch (error) {
    console.error('Error executing query:', error);
  }
}

function combineArrays(cagrResult, result) {
  const combinedArray = [];

  for (const shortlistItem of result) {
    const symbol = shortlistItem.symbol.trim();
    const matchingResultItem = cagrResult.find(cagrItem => cagrItem.symbol.trim() == symbol);

    if (matchingResultItem) {
      const combinedItem = {
        weightedCAGR: matchingResultItem.weightedCAGR,
        totalPurchase: matchingResultItem.totalPurchase,
        totalQuantity: matchingResultItem.totalQuantity,
        ...shortlistItem,
      };
      combinedArray.push(combinedItem);
    } else {
      combinedArray.push(shortlistItem);
    }
  }

  return combinedArray;
}


async function fetchBondsData(dataTable, historyTable) {
  try {
    const query = `
      SELECT
        i.*,
        jsonb_agg(jsonb_build_object('platform', h.platform, 'total_quantity', h.total_quantity)) AS platforms
      FROM
        ${dataTable} i
      LEFT JOIN (
        SELECT
          symbol as issue_code,
          platform,
          SUM(quantity) AS total_quantity
        FROM
          ${historyTable} h
        GROUP BY
          symbol,
          platform
      ) h ON i.issue_code = h.issue_code
      GROUP BY
        i.issue_code;
    `;
    const result = await db.query(query);
    const data = result.rows;

    console.log('Query bonds success');
    return data;
  } catch (error) {
    console.error('Error executing query:', error);
  }
}

// renders
app.get("/", (req, res) => {
    res.render("index.ejs");
  });

app.get("/stocks", async (req, res) => {
  try {
    const cagrresult = await calculateWeightedCAGR("stocks_interested", "stocks_history")
    const stockresult = await fetchStockData("stocks_interested", "stocks_history")
    const result = combineArrays(cagrresult, stockresult);
    
    res.render("stocks.ejs", {data: result});
  } catch (error) {
    console.log(res.statusCode, error.message)
  }
});

app.get("/bonds", async (req, res) => {
  try {
    const result = await fetchBondsData("sg_bonds_data", "bonds_history");
    res.render("bonds.ejs", {data: result});
  } catch (error) {
    console.log(res.statusCode, error.message)
  }
});
  
app.post("/asset", async (req, res) => {
  const eventDate = req.body["aDate"];
  const eventTime = req.body["aTime"];
  const eventSymbol = req.body["aName"];
  const eventType = req.body.selectedType;
  const eventCat = req.body.selectedCat;
  var eventQuantity = req.body["aQuantity"];
  if (eventType == 'Sell' || eventType == 'Put' || eventType == 'Withdraw') {
    eventQuantity *= -1;
  }
  const eventPlatform = req.body["aPlatform"]
  var eventPrice = 0;
  var returnMessage = "Successfully added";
  var returnContent = "";

  try {
    // For Stocks and ETFs, add valid trades to stock_history table
    if (eventCat == "Stocks and ETFs") {
      // add to interested stocks list

      const new_entry = await axios.get(`https://financialmodelingprep.com/api/v3/quote/${eventSymbol}?apikey=${fmpAPIToken}`);
      insertUpdateTable(new_entry.data[0], "stocks_interested", true);

      try {
        //check price
        const result = await axios.get(`https://financialmodelingprep.com/api/v3/historical-chart/1min/${eventSymbol}?from=${eventDate}&to=${eventDate}&apikey=${fmpAPIToken}`);
        for (var i=0; i < result.data.length; i++) {
          if (result.data[i]["date"] ==  `${eventDate} ${eventTime}:00`) {
            eventPrice = result.data[i]["open"];
          }
        };
        if (eventPrice != 0) {
        insertUpdateTable(
          {"symbol": eventSymbol,
          "type": eventType,
          "quantity": eventQuantity, 
          "date": eventDate, 
          "time": eventTime, 
          "purchase_price": eventPrice, 
          "total_price": eventPrice*eventQuantity, 
          "platform": eventPlatform}, "stocks_history", false);
          returnContent = eventSymbol + " Market " + eventType + ": " + eventQuantity + " share(s) at $" + eventPrice + " per share on " + eventPlatform;
        } else {
          returnMessage = "Price at given time cannot be retrieved";
        }
        res.render("addasset.ejs", {content: returnContent,message: returnMessage});
      } catch (error) {
      console.log(res.statusCode, "Symbol does not exist")
    }} else if (eventCat == 'Bonds') {
      const result = await db.query("INSERT INTO bonds_history (symbol, type, quantity, date, time, platform) VALUES ($1,$2, $3, $4, $5, $6)", [eventSymbol, eventType, eventQuantity, eventDate, eventTime, eventPlatform]);
      res.render("addasset.ejs", 
        { addedAssetName: eventSymbol,
            addedAssetEvent: eventType, 
            addedAssetQuantity: eventQuantity,
            addedAssetDate: eventDate,  
            addedAssetTime: eventTime,
            addedAssetPrice: eventPrice,
            message: returnMessage
        })
    }
  } catch (error) {
    console.log(res.statusCode, error.message)
  }
});

app.post("/deletestock", async (req, res) => {
  const symbolDelete = req.body.symbol;
  const platformDelete = req.body.platform;
  const shortlistSymbolDelete = req.body.shortlistsymbol;
  
  if (symbolDelete || platformDelete){
    console.log(symbolDelete, platformDelete, shortlistSymbolDelete, "top");
    try {
      await db.query("DELETE FROM stocks_history WHERE platform = $1 AND symbol = $2", [platformDelete, symbolDelete]);
      res.redirect("/stocks");
    } catch (err) {
      console.log(err);
    }
  }
  if (shortlistSymbolDelete){
    console.log(symbolDelete, platformDelete, shortlistSymbolDelete, "bottom");
    try {
      await db.query("DELETE FROM stocks_interested WHERE symbol = $1", [shortlistSymbolDelete]);
      res.redirect("/stocks");
    } catch (err) {
      console.log(err);
    }
  }  
})

app.post("/deletebond", async (req, res) => {
  const symbolDelete = req.body.issue_code;
  const platformDelete = req.body.platform;
  const shortlistSymbolDelete = req.body.shortlistissue_code;
  
  if (symbolDelete || platformDelete){
    console.log(symbolDelete, platformDelete, shortlistSymbolDelete, "top");
    try {
      await db.query("DELETE FROM bonds_history WHERE platform = $1 AND symbol = $2", [platformDelete, symbolDelete]);
      res.redirect("/bonds");
    } catch (err) {
      console.log(err);
    }
  }
  if (shortlistSymbolDelete){
    console.log(symbolDelete, platformDelete, shortlistSymbolDelete, "bottom");
    try {
      await db.query("DELETE FROM bonds_history WHERE symbol = $1", [shortlistSymbolDelete]);
      res.redirect("/bonds");
    } catch (err) {
      console.log(err);
    }
  }  
})

app.post('/analytics', async (req, res) => {
  try {
    const ticker = req.body.chosenticker;
    console.log("ticker = " + ticker, req.body)
    const config = {
      headers: { Authorization: `Bearer ${process.env.QUIVER_TOKEN}` },
    };
    const result = await axios.get("https://api.quiverquant.com/beta/live/senatetrading?options=true", config);
    const filtered = result.data.filter(item => item.Ticker === ticker);
    console.log(filtered[0].Senator);

    res.render("analytics.ejs", {data: filtered});
  } catch (err) {
    console.log(err);
  }
});


app.post("/", (req, res) => {
    res.render("index.ejs", {data: trades});
})

app.listen(port, () => {
    console.log(`Listening on port ${port}`);
  });