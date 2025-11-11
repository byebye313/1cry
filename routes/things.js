const express = require('express');
const router = express.Router();
const axios = require('axios');

// In-memory cache object
const cache = {
    data: [],
    lastUpdated: null,
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Function to fetch historical data for 30 days and cache it
const fetchAndCacheData = async () => {
    console.log("Fetching and caching historical data");

    const now = new Date();
    const data = [];

    // Fetch data for 30 days
    for (let i = 0; i < 10; i++) {
        const date = new Date(now);
        date.setDate(now.getDate() - i);
        const formattedDate = `${('0' + date.getDate()).slice(-2)}-${('0' + (date.getMonth() + 1)).slice(-2)}-${date.getFullYear()}`;
        console.log(`Fetching data for date: ${formattedDate}`);

        try {
            // Fetch data from the API
            const response = await axios.get(`https://api.coingecko.com/api/v3/coins/bitcoin/history?date=${formattedDate}`);
            console.log(`Received response for date: ${formattedDate}`);

            if (response.data && response.data.market_data && response.data.market_data.current_price) {
                const openPrice = response.data.market_data.current_price.usd;
                const closePrice = openPrice * (1 + (Math.random() * 0.1 - 0.05)); // simulate close price with random fluctuation
                const leverage = Math.floor(Math.random() * 10) + 1;
                const depositAmount = 1000; // USD
                const profit = (closePrice - openPrice) * leverage * (depositAmount / openPrice); // calculate profit based on leverage

                const lastUpdated = response.data.market_data.last_updated || '';
                const dateString = lastUpdated ? lastUpdated.split('T')[0] : formattedDate;

                data.push({
                    date: dateString,
                    openPrice,
                    closePrice,
                    leverage,
                    profit
                });
            } else {
                console.error(`No market data found for date: ${formattedDate}`);
            }
        } catch (apiError) {
            console.error(`Failed to fetch data for date: ${formattedDate}`, apiError.message);
        }

        // Introduce a delay to prevent hitting the rate limit
        await delay(6500);  // Delay of 1.5 seconds
    }

    // Keep only the most recent 7 days of data
    cache.data = data.slice(0, 7).reverse();
    cache.lastUpdated = new Date();

    console.log("Data cached successfully");
};

// Fetch data on server startup and every 24 hours
fetchAndCacheData();
setInterval(fetchAndCacheData, 24 * 60 * 60 * 1000); // Every 24 hours

router.get('/ai/historical-data', (req, res) => {
    console.log("Received request for cached historical data");

    if (!cache.data.length || !cache.lastUpdated) {
        return res.status(500).json({ error: 'Cache is empty or data is not yet available' });
    }

    console.log("Sending cached data");
    res.json(cache.data);
});

module.exports = router;
