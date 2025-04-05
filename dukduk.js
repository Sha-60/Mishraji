const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');

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
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, `login_error_${Date.now()}.png`) });
        return true; // Continue even if login fails
    }
}

// Modified main execution flow
(async () => {
    const browser = await puppeteer.launch({
        headless: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        slowMo: 50 // Adds slight delay between actions
    });
    
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1440, height: 900 });
        
        // Set realistic user agent
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');

        // Step 1: Execute login flow
        console.log('Step 1: Logging in...');
        await handleLogin(page);
        console.log('✅ Login attempt completed');

        // Step 2: Read symbols from CSV
        console.log('Step 2: Reading symbols...');
        const symbols = await readSymbols();
        console.log(`Found ${symbols.length} symbols to process`);

        // Step 3: Process each symbol
        for(const symbol of symbols) {
            console.log(`\nProcessing ${symbol}...`);
            try {
                // Get company profile URL
                const profileUrl = await getMoneycontrolLink(page, symbol);
                console.log(`Found profile URL: ${profileUrl}`);

                // Navigate to company page
                await page.goto(profileUrl, { 
                    waitUntil: 'domcontentloaded', 
                    timeout: 30000 
                });

                // Wait for page to load
                await page.waitForSelector('.pcstname, h1', { timeout: 30000 });
                
                // Scrape company data
                const companyInfo = await getCompanyInfo(page, symbol);
                console.log('✅ Company info scraped');

                // Try to get SWOT analysis
                let swotAnalysis = [];
                try {
                    swotAnalysis = await getSWOTAnalysis(page);
                    console.log('✅ SWOT analysis scraped');
                } catch (error) {
                    console.log('⚠️ Could not get SWOT analysis:', error.message);
                }

                // Try to get news
                let news = [];
                try {
                    news = await getNewsData(page);
                    console.log('✅ News data scraped');
                } catch (error) {
                    console.log('⚠️ Could not get news data:', error.message);
                }

                // Add this new function to scrape MC Essentials data
                let mcEssentials = null;
                try {
                    mcEssentials = await getMCEssentials(page);
                    console.log('✅ MC Essentials data scraped');
                } catch (error) {
                    console.log('⚠️ Could not get MC Essentials:', error.message);
                }

                // Format and save output
                const output = formatOutput(symbol, {
                    companyInfo,
                    swotAnalysis,
                    news,
                    profileUrl,
                    mcEssentials
                });
                
                fs.appendFileSync(OUTPUT_FILE, output);
                console.log(`✅ Successfully processed ${symbol}`);

                // Take screenshot
                await page.screenshot({
                    path: path.join(SCREENSHOT_DIR, `${symbol}_${Date.now()}.png`),
                    fullPage: true
                });

                // Add delay between requests
                await new Promise(resolve => setTimeout(resolve, 5000));
                
            } catch(error) {
                console.error(`Error processing ${symbol}:`, error.message);
                const errorMsg = `\nERROR PROCESSING ${symbol}: ${error.message}\n\n`;
                fs.appendFileSync(OUTPUT_FILE, errorMsg);
            }
        }
        
    } catch (error) {
        console.error('Fatal error:', error);
    } finally {
        await browser.close();
        console.log('Scraping completed. Results saved to', OUTPUT_FILE);
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

// Enhanced News Scraper with Article Content
async function getNewsData(page) {
    const newsItems = await page.$$eval('.newsblock1, .news_list li', items => 
        items.slice(0, 5).map(item => ({
            title: item.querySelector('h3 a')?.textContent?.trim() || 'No title',
            url: item.querySelector('a')?.href || '#',
            time: item.querySelector('.datetime')?.textContent?.trim() || 'N/A'
        }))
    );

    // Scrape article content for each news item
    for(const item of newsItems) {
        if(item.url && item.url !== '#') {
            try {
                const newPage = await page.browser().newPage();
                await newPage.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                item.content = await newPage.$eval('h2.article_desc', el => el.textContent.trim()) || 'No content available';
                await newPage.close();
            } catch(error) {
                item.content = 'Failed to retrieve article content';
            }
        } else {
            item.content = 'No content available';
        }
    }

    return newsItems;
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

// Modify the formatOutput function to include MC Essentials data
function formatOutput(symbol, data) {
    let output = `\n${'='.repeat(80)}\n`;
    output += `Company: ${data.companyInfo.name.toUpperCase()} (${symbol})\n`;
    output += `Profile URL: ${data.profileUrl}\n\n`;
    
    // Add MC Essentials section
    if (data.mcEssentials) {
        output += `MC Essentials:\n`;
        output += `  Overall Score: ${data.mcEssentials.passPercentage}\n\n`;
        
        if (data.mcEssentials.details) {
            output += `  Financials:\n`;
            data.mcEssentials.details.financials.forEach(item => {
                output += `    ${item.passed ? '✓' : '✗'} ${item.text}\n`;
            });
            
            output += `\n  Ownership:\n`;
            data.mcEssentials.details.ownership.forEach(item => {
                output += `    ${item.passed ? '✓' : '✗'} ${item.text}\n`;
            });
            
            output += `\n  Industry Comparison:\n`;
            data.mcEssentials.details.industryComparison.forEach(item => {
                output += `    ${item.passed ? '✓' : '✗'} ${item.text}\n`;
            });
            
            output += `\n  Others:\n`;
            data.mcEssentials.details.others.forEach(item => {
                output += `    ${item.passed ? '✓' : '✗'} ${item.text}\n`;
            });
        }
        output += '\n';
    }
    
    output += `SWOT Analysis:\n`;
    if (data.swotAnalysis.length === 0) {
        output += `  No SWOT analysis data available\n\n`;
    } else {
        data.swotAnalysis.forEach((item) => {
            output += `  ${item.category} (${item.count})\n`;
            output += `     Summary: ${item.summary}\n`;
            if (item.details && item.details.length > 0) {
                output += `     Details:\n`;
                item.details.forEach((detail, index) => {
                    output += `       ${index + 1}. ${detail}\n`;
                });
            }
            output += '\n';
        });
    }
    
    output += `Recent News (${data.news.length} items):\n`;
    data.news.forEach((item, index) => {
        output += `  ${index + 1}. [${item.time}] ${item.title}\n`;
        output += `     ${item.content}\n`;
        output += `     Read more: ${item.url}\n\n`;
    });
    
    output += `${'='.repeat(80)}\n\n`;
    return output;
}