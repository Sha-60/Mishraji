const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const axios = require('axios');

// WordPress Configuration
const WP_API_URL = 'https://profitbooking.in/wp-json/scraper/v1/moneycontrol_swot'; // Updated to match the correct route


// SQL Table Creation Query
/*
CREATE TABLE moneycontrol_data (
    id INT AUTO_INCREMENT PRIMARY KEY,
    symbol VARCHAR(50) NOT NULL,
    strengths_count INT,
    strengths_summary TEXT,
    weaknesses_count INT,
    weaknesses_summary TEXT,
    opportunities_count INT,
    opportunities_summary TEXT,
    threats_count INT,
    threats_summary TEXT,
    mc_essentials_score INT,
    piotroski_score VARCHAR(10),
    piotroski_indicates TEXT,
    three_year_cagr JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
*/

// Configure directories
const OUTPUT_FILE = 'moneycontrol_data.txt';
const SYMBOLS_FILE = 'symbols.csv';

// Initialize output file
fs.writeFileSync(OUTPUT_FILE, `Moneycontrol Data Scrape - ${new Date().toISOString()}\n\n`);

// Main execution flow
(async () => {
    const browser = await puppeteer.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--window-size=1440,900'
        ]
    });
    
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1440, height: 900 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');

        const symbols = await readSymbols();

        for(const symbol of symbols) {
            try {
                const profileUrl = await getMoneycontrolLink(page, symbol);
                await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
                await page.waitForSelector('.pcstname, h1', { timeout: 60000 });
                
                let swotAnalysis = [];
                try {
                    swotAnalysis = await getSWOTAnalysis(page);
                } catch (error) {
                    console.log('⚠️ Could not get SWOT analysis:', error.message);
                }

                let mcEssentials = null;
                try {
                    mcEssentials = await getMCEssentials(page);
                } catch (error) {
                    console.log('⚠️ Could not get MC Essentials:', error.message);
                }

                let financialsData = null;
                try {
                    financialsData = await getFinancialsData(page);
                } catch (error) {
                    console.log('⚠️ Could not get Financials data:', error.message);
                }

                // Format data for WordPress storage
                const wpPayload = {
                    symbol: symbol,
                    strengths_count: swotAnalysis.find(item => item.category === 'Strengths')?.count || 0,
                    strengths_summary: swotAnalysis.find(item => item.category === 'Strengths')?.summary || '',
                    weaknesses_count: swotAnalysis.find(item => item.category === 'Weaknesses')?.count || 0,
                    weaknesses_summary: swotAnalysis.find(item => item.category === 'Weaknesses')?.summary || '',
                    opportunities_count: swotAnalysis.find(item => item.category === 'Opportunities')?.count || 0,
                    opportunities_summary: swotAnalysis.find(item => item.category === 'Opportunities')?.summary || '',
                    threats_count: swotAnalysis.find(item => item.category === 'Threats')?.count || 0,
                    threats_summary: swotAnalysis.find(item => item.category === 'Threats')?.summary || '',
                    mc_essentials_score: mcEssentials?.passPercentage ? parseInt(mcEssentials.passPercentage.match(/\d+/)[0]) : 0,
                    piotroski_score: financialsData?.piotroskiScore || '',
                    piotroski_indicates: financialsData?.piotroskiIndicates || '',
                    three_year_cagr: financialsData?.threeYearCAGR || {}
                };

                // Store data in WordPress
                await storeData(wpPayload);

                // Save data to file (keeping the original file output for backup)
                const output = formatOutput(symbol, {
                    swotAnalysis,
                    mcEssentials,
                    financialsData
                });
                fs.appendFileSync(OUTPUT_FILE, output);

                await new Promise(resolve => setTimeout(resolve, 3000));
                
            } catch(error) {
                console.error(`Error processing ${symbol}:`, error.message);
                fs.appendFileSync(OUTPUT_FILE, `\nERROR PROCESSING ${symbol}: ${error.message}\n\n`);
            }
        }
    } catch (error) {
        console.error('Fatal error:', error);
    } finally {
        await browser.close();
    }
})();

// Read symbols from CSV
async function readSymbols() {
    return new Promise((resolve, reject) => {
        const symbols = [];
        fs.createReadStream(SYMBOLS_FILE)
            .pipe(csv())
            .on('data', (row) => {
                const symbol = row['Symbo1'] || row['Symbol'] || row['symbol'];
                if(symbol && symbol.trim()) symbols.push(symbol.trim());
            })
            .on('end', () => {
                if(symbols.length === 0) reject(new Error('No valid symbols found in CSV'));
                resolve([...new Set(symbols)]);
            })
            .on('error', reject);
    });
}

// Get Moneycontrol link for symbol
async function getMoneycontrolLink(page, symbol, retries = 3) {
    for(let attempt = 1; attempt <= retries; attempt++) {
        try {
            await page.goto('https://duckduckgo.com/', { 
                waitUntil: 'networkidle2', 
                timeout: 60000 
            });

            await page.type('#searchbox_input', `site:moneycontrol.com ${symbol} stock price`);
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }),
                page.keyboard.press('Enter')
            ]);

            await page.waitForSelector('[data-testid="mainline"] li[data-layout="organic"]', { timeout: 15000 });
            const firstResult = await page.$('[data-testid="mainline"] li[data-layout="organic"]');
            return await firstResult.$eval('a[data-testid="result-title-a"]', a => a.href);
        } catch(error) {
            if(attempt === retries) {
                throw new Error(`Search failed for ${symbol}: ${error.message}`);
            }
            console.log(`Retrying search for ${symbol} (attempt ${attempt})`);
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
}

// Simplified SWOT Analysis Scraper - Only gets counts and titles
async function getSWOTAnalysis(page) {
    const swotData = [];

    try {
        await page.waitForSelector('.swot_cnt', { timeout: 5000 });
        
        const swotCategories = ['swli1', 'swli2', 'swli3', 'swli4'];
        const categoryNames = ['Strengths', 'Weaknesses', 'Opportunities', 'Threats'];

        for (let i = 0; i < swotCategories.length; i++) {
            try {
                const categoryInfo = await page.evaluate((selector) => {
                    const element = document.querySelector(`.${selector}`);
                    if (!element) return null;
                    
                    const strongElement = element.querySelector('strong');
                    const emElement = element.querySelector('em');
                    
                    return {
                        title: strongElement?.textContent?.trim() || '',
                        summary: emElement?.textContent?.trim() || ''
                    };
                }, swotCategories[i]);

                if (categoryInfo) {
                    const countMatch = categoryInfo.title.match(/\((\d+)\)/);
                    swotData.push({
                        category: categoryNames[i],
                        count: countMatch ? countMatch[1] : '0',
                        summary: categoryInfo.summary
                    });
                }
            } catch (error) {
                console.log(`⚠️ Error processing ${categoryNames[i]}:`, error.message);
            }
        }
    } catch (error) {
        console.log('⚠️ SWOT section not found or error:', error.message);
    }

    return swotData;
}

// Simplified MC Essentials - Only gets percentage
async function getMCEssentials(page) {
    try {
        await page.waitForSelector('.bx_mceti', { timeout: 5000 });

        const passPercentage = await page.evaluate(() => {
            const element = document.querySelector('.esbx');
            if (!element) return null;
            return element.textContent.trim();
        });

        return { passPercentage };
    } catch (error) {
        console.log('⚠️ MC Essentials section not found or error:', error.message);
        return null;
    }
}

// Simplified Financials Data - Only gets Piotroski Score
async function getFinancialsData(page) {
    try {
        await page.waitForSelector('#mc_insight', { timeout: 5000 });

        const data = await page.evaluate(() => {
            const result = {
                piotroskiScore: null,
                piotroskiIndicates: '',
                threeYearCAGR: {}
            };

            // Get Financials Data
            const financialsSection = Array.from(document.querySelectorAll('.grey_bx.mcinbx'))
                .find(div => div.querySelector('a[href="#financials"]'));
            
            if (financialsSection) {
                // Get Piotroski Score
                const piotroskiDiv = financialsSection.querySelector('.fpioi');
                if (piotroskiDiv) {
                    result.piotroskiScore = piotroskiDiv.querySelector('.nof')?.textContent?.trim();
                    result.piotroskiIndicates = piotroskiDiv.querySelector('p')?.textContent?.trim();
                }

                // Get 3 Year CAGR Growth
                const cagrTable = financialsSection.querySelector('.frevdat');
                if (cagrTable) {
                    const rows = cagrTable.querySelectorAll('tr');
                    rows.forEach(row => {
                        const cells = row.querySelectorAll('td');
                        if (cells.length === 2) {
                            result.threeYearCAGR[cells[0].textContent.trim()] = cells[1].textContent.trim();
                        }
                    });
                }
            }

            return result;
        });

        return data;

    } catch (error) {
        console.log('⚠️ Financials data not found or error:', error.message);
        return null;
    }
}

// Simplified output formatter
function formatOutput(symbol, data) {
    let output = `\n${'='.repeat(80)}\n`;
    output += `Symbol: ${symbol}\n\n`;
    
    // SWOT Analysis - Counts and summaries
    if (data.swotAnalysis && data.swotAnalysis.length > 0) {
        data.swotAnalysis.forEach((item) => {
            output += `${item.category}_Count: ${item.count}\n`;
            if (item.summary) {
                output += `${item.category}_Summary: ${item.summary}\n`;
            }
        });
    }
    
    // MC Essentials - Only percentage
    if (data.mcEssentials && data.mcEssentials.passPercentage) {
        const percentageMatch = data.mcEssentials.passPercentage.match(/\d+/);
        const percentage = percentageMatch ? percentageMatch[0] : '0';
        output += `MC_Essentials_Score: ${percentage}\n`;
    }
    
    // Financials Data
    if (data.financialsData) {
        if (data.financialsData.piotroskiScore) {
            output += `Piotroski_Score: ${data.financialsData.piotroskiScore}\n`;
        }
        if (data.financialsData.piotroskiIndicates) {
            output += `Piotroski_Indicates: ${data.financialsData.piotroskiIndicates}\n`;
        }
        if (Object.keys(data.financialsData.threeYearCAGR).length > 0) {
            output += `Three_Year_CAGR:\n`;
            Object.entries(data.financialsData.threeYearCAGR).forEach(([key, value]) => {
                output += `  ${key}: ${value}\n`;
            });
        }
    }
    
    output += `${'='.repeat(80)}\n\n`;
    return output;
}

// Function to store data in WordPress
async function storeData(payload) {
    try {
        console.log('Sending payload:', JSON.stringify(payload, null, 2));
        
        const response = await axios.post(WP_API_URL, payload);

        console.log('API Response:', response.data);
        return response.data;
    } catch (error) {
        console.error('Storage API error:', {
            status: error.response?.status,
            data: error.response?.data,
            message: error.message
        });
        return null;
    }
}