const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const axios = require('axios');

// Configure directories
const SCREENSHOT_DIR = 'screenshots';
const OUTPUT_FILE = 'moneycontrol_data.txt';
const SYMBOLS_FILE = 'symbols.csv';
                                            
// Initialize directories
!fs.existsSync(SCREENSHOT_DIR) && fs.mkdirSync(SCREENSHOT_DIR);
fs.writeFileSync(OUTPUT_FILE, `Moneycontrol Data Scrape - ${new Date().toISOString()}\n\n`);

async function handleLogin(page) {
    try {
        console.log('🚀 Starting login process...');
        
        // 1. Navigate to login page
        await page.goto('https://accounts.moneycontrol.com/mclogin/?v=2&d=2&redirect=home', {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });

        // 2. Handle cookie consent
        try {
            await page.waitForSelector('#wzrk-cancel', { timeout: 5000 });
            await page.click('#wzrk-cancel');
            console.log('✅ Closed cookie consent');
        } catch {
            console.log('ℹ️ No cookie consent found');
        }

        // 3. Switch to password login
        console.log('🔑 Switching to password login...');
        await page.waitForSelector('li.signup_ctc[data-target="#mc_login"]', { 
            visible: true, 
            timeout: 15000 
        });
        
        await page.evaluate(() => {
            document.querySelector('li.signup_ctc[data-target="#mc_login"]').click();
        });
        console.log('✅ Password login clicked');

        // 4. Wait for form elements
        console.log('⏳ Waiting for login form...');
        await page.waitForSelector('#mc_login', { visible: true, timeout: 30000 });
        await page.waitForSelector('#mc_login input[name="email"]', { visible: true, timeout: 30000 });
        await page.waitForSelector('#mc_login input[name="pwd"]', { visible: true, timeout: 30000 });
        await page.waitForSelector('#mc_login .login_verify_btn', { visible: true, timeout: 30000 });
        
        console.log('✅ Login form visible');

        // 5. Fill credentials
        console.log('📧 Filling credentials...');
        await page.type('#mc_login input[name="email"]', 'raj@episodiclabs.com', { delay: 50 });
        await page.type('#mc_login input[name="pwd"]', 'Sentobird@2025', { delay: 50 });

        // 6. Submit form by clicking the login button
        console.log('🔐 Submitting form...');
        await page.click('#mc_login .login_verify_btn');

        // Wait for navigation with a shorter timeout
        try {
            await page.waitForNavigation({ 
                waitUntil: 'domcontentloaded', 
                timeout: 30000 
            });
        } catch (error) {
            console.log('⚠️ Navigation timeout, but continuing...');
        }

        return true;

    } catch (error) {
        console.error('🔥 Login failed:', error.message);
        // await page.screenshot({ path: path.join(SCREENSHOT_DIR, `login_error_${Date.now()}.png`) });
        return true; // Continue even if login fails
    }
}

// Modified main execution flow
(async () => {
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        slowMo: 50
    });
    
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1440, height: 900 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');

        await handleLogin(page);
        const symbols = await readSymbols();

        for(const symbol of symbols) {
            try {
                const profileUrl = await getMoneycontrolLink(page, symbol);
                await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await page.waitForSelector('.pcstname, h1', { timeout: 30000 });
                
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

                let mcInsightsData = null;
                try {
                    mcInsightsData = await getFinancialsAndIndustryData(page);
                } catch (error) {
                    console.log('⚠️ Could not get MC Insights data:', error.message);
                }

                // Prepare API data
                const apiData = prepareApiData(symbol, {
                    swotAnalysis,
                    mcEssentials,
                    mcInsightsData
                });

                // Send data to WordPress API
                try {
                    const response = await sendToWordPressApi(apiData);
                    console.log(`✅ Data sent to API for ${symbol}:`, response.data);
                } catch (error) {
                    console.error(`🔥 API Error for ${symbol}:`, error.message);
                }
                
                // Still save to file as backup
                // const output = formatOutput(symbol, {
                //     swotAnalysis,
                //     mcEssentials,
                //     mcInsightsData
                // });
                // fs.appendFileSync(OUTPUT_FILE, output);

                await new Promise(resolve => setTimeout(resolve, 5000));
                
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

// Enhanced symbol reader
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

// DuckDuckGo search with improved reliability
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

// SWOT Analysis Scraper
async function getSWOTAnalysis(page) {
    const swotData = [];

    try {
        // Wait for SWOT content container
        await page.waitForSelector('.swot_cnt', { timeout: 5000 });
        
        // Define the SWOT categories and their corresponding selectors
        const swotCategories = [
            { class: 'swli1', id: 'swot_ls', name: 'Strengths', contentDiv: 'swliSDiv' },
            { class: 'swli2', id: 'swot_lw', name: 'Weaknesses', contentDiv: 'swliWDiv' },
            { class: 'swli3', id: 'swot_lo', name: 'Opportunities', contentDiv: 'swliODiv' },
            { class: 'swli4', id: 'swot_lt', name: 'Threats', contentDiv: 'swliTDiv' }
        ];

        // Process each SWOT category
        for (const category of swotCategories) {
            try {
                // Get category info first
                const categoryInfo = await page.evaluate((selector) => {
                    const element = document.querySelector(`.${selector}`);
                    if (!element) return null;
                    return {
                        title: element.querySelector('strong')?.textContent?.trim() || '',
                        summary: element.querySelector('em')?.textContent?.trim() || ''
                    };
                }, category.class);

                if (!categoryInfo) continue;

                // Click the category button
                await page.evaluate((selector) => {
                    const element = document.querySelector(`.${selector} a`);
                    if (element) element.click();
                }, category.class);

                // Wait for content to load
                await new Promise(resolve => setTimeout(resolve, 5000));

                // Get the detailed items
                const items = await page.evaluate((divId) => {
                    const contentDiv = document.querySelector(`#${divId}`);
                    if (!contentDiv) return [];
                    
                    const items = [];
                    const listItems = contentDiv.querySelectorAll('li');
                    listItems.forEach(li => {
                        const text = li.textContent.trim();
                        if (text) items.push(text);
                    });
                    return items;
                }, category.contentDiv);

                // Extract count from title (e.g., "Strengths (10)" -> "10")
                const countMatch = categoryInfo.title.match(/\((\d+)\)/);
                const count = countMatch ? countMatch[1] : '0';

                // Add to SWOT data
                swotData.push({
                    category: categoryInfo.title.replace(/\s*\(\d+\)/, ''), // Remove count from category name
                    count: count,
                    summary: categoryInfo.summary,
                    details: items
                });

                // Close the category to avoid overlap
                await page.evaluate((selector) => {
                    const closeBtn = document.querySelector(`.${selector} .swlicl`);
                    if (closeBtn) closeBtn.click();
                }, category.class);

                // Wait for animation to complete
                await new Promise(resolve => setTimeout(resolve, 500));

            } catch (error) {
                console.log(`⚠️ Error processing ${category.name}:`, error.message);
            }
        }

    } catch (error) {
        console.log('⚠️ SWOT section not found or error:', error.message);
    }

    return swotData;
}

// Company Data Scraper
async function getCompanyInfo(page, symbol) {
    return page.evaluate((symbol) => {
        const cleanText = (el) => el?.textContent?.replace(/\s+/g, ' ').trim();
        
        return {
            name: cleanText(document.querySelector('.pcstname') || document.querySelector('h1')) || symbol,
            price: cleanText(document.querySelector('#nsecp')) || 'N/A',
            change: cleanText(document.querySelector('#nsechange')) || 'N/A'
        };
    }, symbol);
}

// Add this new function to scrape MC Essentials data
async function getMCEssentials(page) {
    try {
        // Wait for MC Essentials section
        await page.waitForSelector('.bx_mceti', { timeout: 5000 });

        // Get the pass percentage first
        const passPercentage = await page.evaluate(() => {
            const element = document.querySelector('.esbx');
            if (!element) return null;
            return element.textContent.trim();
        });

        // Click to open MC Essentials details
        await page.evaluate(() => {
            const element = document.querySelector('.arw_line');
            if (element) element.click();
        });

        // Wait for content to load
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Get detailed analysis
        const details = await page.evaluate(() => {
            const data = {
                financials: [],
                ownership: [],
                industryComparison: [],
                others: []
            };

            // Helper function to determine if item is checked (has green checkmark)
            const isChecked = (span) => {
                return span.querySelector('svg path[style*="3BB54A"]') !== null;
            };

            // Get Financials
            const financialsItems = document.querySelectorAll('#id_financials li');
            financialsItems.forEach(item => {
                data.financials.push({
                    text: item.childNodes[0].textContent.trim(),
                    passed: isChecked(item.querySelector('span'))
                });
            });

            // Get Ownership
            const ownershipItems = document.querySelectorAll('#id_ownership li');
            ownershipItems.forEach(item => {
                data.ownership.push({
                    text: item.childNodes[0].textContent.trim(),
                    passed: isChecked(item.querySelector('span'))
                });
            });

            // Get Industry Comparison
            const industryItems = document.querySelectorAll('#id_induscmp li');
            industryItems.forEach(item => {
                data.industryComparison.push({
                    text: item.childNodes[0].textContent.trim(),
                    passed: isChecked(item.querySelector('span'))
                });
            });

            // Get Others
            const otherItems = document.querySelectorAll('#id_others li');
            otherItems.forEach(item => {
                data.others.push({
                    text: item.childNodes[0].textContent.trim(),
                    passed: isChecked(item.querySelector('span'))
                });
            });

            return data;
        });

        return {
            passPercentage,
            details
        };

    } catch (error) {
        console.log('⚠️ MC Essentials section not found or error:', error.message);
        return null;
    }
}

// Modified formatOutput function
function formatOutput(symbol, data) {
    let output = `\n${'='.repeat(80)}\n`;
    output += `Symbol: ${symbol}\n\n`;
    
    // SWOT Analysis - Only counts and items
    if (data.swotAnalysis && data.swotAnalysis.length > 0) {
        data.swotAnalysis.forEach((item) => {
            const count = parseInt(item.count) || 0;
            output += `${item.category}_Count: ${count}\n`;
            output += `${item.category}_Items: ${JSON.stringify(item.details)}\n`;
        });
    }
    
    // MC Essentials - Only percentage and boolean checks
    if (data.mcEssentials) {
        const percentageMatch = data.mcEssentials.passPercentage.match(/\d+/);
        const percentage = percentageMatch ? percentageMatch[0] : '0';
        output += `MC_Essentials_Score: ${percentage}\n`;
        
        if (data.mcEssentials.details) {
            // Financial checks (numbered 1-8)
            data.mcEssentials.details.financials.forEach((item, index) => {
                output += `financials_${index + 1}: ${item.passed}\n`;
            });

            // Ownership checks (numbered 1-3)
            data.mcEssentials.details.ownership.forEach((item, index) => {
                output += `ownership_${index + 1}: ${item.passed}\n`;
            });

            // Industry comparison checks (numbered 1-3)
            data.mcEssentials.details.industryComparison.forEach((item, index) => {
                output += `industry_${index + 1}: ${item.passed}\n`;
            });

            // Others checks (numbered 1-2)
            data.mcEssentials.details.others.forEach((item, index) => {
                output += `others_${index + 1}: ${item.passed}\n`;
            });
        }
    }
    
    // Only Piotroski Score
    if (data.mcInsightsData && data.mcInsightsData.financials.piotroskiScore) {
        output += `Piotroski_Score: ${data.mcInsightsData.financials.piotroskiScore}\n`;
    }
    
    output += `${'='.repeat(80)}\n\n`;
    return output;
}

async function getFinancialsAndIndustryData(page) {
    try {
        // Wait for the MC Insights container
        await page.waitForSelector('#mc_insight', { timeout: 5000 });
        console.log('Found MC Insights container');

        const data = await page.evaluate(() => {
            const result = {
                mcInsightSummary: '',
                price: [],
                financials: {
                    piotroskiScore: null,
                    piotroskiIndicates: '',
                    threeYearCAGR: {}
                },
                industryComparison: []
            };

            // Get MC Insight Summary
            const summaryDiv = document.querySelector('.mcpperf .insightRight');
            if (summaryDiv) {
                result.mcInsightSummary = summaryDiv.textContent.trim();
            }

            // Get Price Insights
            const priceSection = document.querySelector('.grey_bx.mcinbx');
            if (priceSection) {
                const priceItems = priceSection.querySelectorAll('li');
                priceItems.forEach(item => {
                    const status = item.classList.contains('green') ? 'Positive' :
                                 item.classList.contains('red') ? 'Negative' :
                                 'Neutral';
                    result.price.push({
                        text: item.textContent.trim(),
                        status: status
                    });
                });
            }

            // Get Financials Data
            const financialsSection = Array.from(document.querySelectorAll('.grey_bx.mcinbx'))
                .find(div => div.querySelector('a[href="#financials"]'));
            
            if (financialsSection) {
                // Get Piotroski Score
                const piotroskiDiv = financialsSection.querySelector('.fpioi');
                if (piotroskiDiv) {
                    result.financials.piotroskiScore = piotroskiDiv.querySelector('.nof')?.textContent?.trim();
                    result.financials.piotroskiIndicates = piotroskiDiv.querySelector('p')?.textContent?.trim();
                }

                // Get 3 Year CAGR Growth
                const cagrTable = financialsSection.querySelector('.frevdat');
                if (cagrTable) {
                    const rows = cagrTable.querySelectorAll('tr');
                    rows.forEach(row => {
                        const cells = row.querySelectorAll('td');
                        if (cells.length === 2) {
                            result.financials.threeYearCAGR[cells[0].textContent.trim()] = cells[1].textContent.trim();
                        }
                    });
                }
            }

            // Get Industry Comparison
            const industrySection = Array.from(document.querySelectorAll('.grey_bx.mcinbx'))
                .find(div => div.querySelector('a[href="#peers"]'));
            
            if (industrySection) {
                const items = industrySection.querySelectorAll('li');
                items.forEach(item => {
                    const status = item.classList.contains('green') ? 'Positive' :
                                 item.classList.contains('red') ? 'Negative' :
                                 item.classList.contains('nutral') ? 'Neutral' : 'Unknown';
                    
                    result.industryComparison.push({
                        text: item.textContent.trim(),
                        status: status
                    });
                });
            }

            return result;
        });

        return data;

    } catch (error) {
        console.log('⚠️ MC Insights data not found or error:', error.message);
        return null;
    }
}

// Add new function to prepare API data
function prepareApiData(symbol, data) {
    const apiData = {
        symbol: symbol,
        Strengths_Count: 0,
        Weaknesses_Count: 0,
        Opportunities_Count: 0,
        Threats_Count: 0,
        Strengths_Items: '[]',
        Weaknesses_Items: '[]',
        Opportunities_Items: '[]',
        Threats_Items: '[]',
        MC_Essentials_Score: 0,
        Piotroski_Score: 0
    };

    // Process SWOT data
    if (data.swotAnalysis && data.swotAnalysis.length > 0) {
        data.swotAnalysis.forEach(item => {
            const category = item.category;
            const count = parseInt(item.count) || 0;
            const details = JSON.stringify(item.details || []);

            switch(category) {
                case 'Strengths':
                    apiData.Strengths_Count = count;
                    apiData.Strengths_Items = details;
                    break;
                case 'Weaknesses':
                    apiData.Weaknesses_Count = count;
                    apiData.Weaknesses_Items = details;
                    break;
                case 'Opportunities':
                    apiData.Opportunities_Count = count;
                    apiData.Opportunities_Items = details;
                    break;
                case 'Threats':
                    apiData.Threats_Count = count;
                    apiData.Threats_Items = details;
                    break;
            }
        });
    }

    // Process MC Essentials data
    if (data.mcEssentials) {
        const percentageMatch = data.mcEssentials.passPercentage.match(/\d+/);
        apiData.MC_Essentials_Score = percentageMatch ? parseInt(percentageMatch[0]) : 0;

        if (data.mcEssentials.details) {
            // Add boolean fields
            data.mcEssentials.details.financials.forEach((item, index) => {
                apiData[`financials_${index + 1}`] = item.passed;
            });

            data.mcEssentials.details.ownership.forEach((item, index) => {
                apiData[`ownership_${index + 1}`] = item.passed;
            });

            data.mcEssentials.details.industryComparison.forEach((item, index) => {
                apiData[`industry_${index + 1}`] = item.passed;
            });

            data.mcEssentials.details.others.forEach((item, index) => {
                apiData[`others_${index + 1}`] = item.passed;
            });
        }
    }

    // Add Piotroski Score
    if (data.mcInsightsData && data.mcInsightsData.financials.piotroskiScore) {
        apiData.Piotroski_Score = parseInt(data.mcInsightsData.financials.piotroskiScore) || 0;
    }

    return apiData;
}

// Add new function to send data to WordPress API
async function sendToWordPressApi(data) {
    const API_URL = 'https://profitbooking.in/wp-json/moneycon/v1/money_con';
    
    try {
        const response = await axios.post(API_URL, data, {
            headers: {
                'Content-Type': 'application/json'
            }
        });
        return response;
    } catch (error) {
        console.error('API Error:', error.response?.data || error.message);
        throw error;
    }
}