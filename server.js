const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// PostgreSQL connection with proper Neon configuration
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize database tables
async function initializeDatabase() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS signals (
                id SERIAL PRIMARY KEY,
                ticker VARCHAR(20) NOT NULL,
                action VARCHAR(10) NOT NULL,
                price DECIMAL(10,5) NOT NULL,
                timestamp TIMESTAMP,
                received_at TIMESTAMP DEFAULT NOW(),
                analyzed BOOLEAN DEFAULT FALSE,
                analyzed_by VARCHAR(100),
                analyzed_at TIMESTAMP,
                response_time_seconds DECIMAL(8,2)
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS trades (
                id SERIAL PRIMARY KEY,
                signal_id INTEGER REFERENCES signals(id),
                pair VARCHAR(20) NOT NULL,
                direction VARCHAR(10) NOT NULL,
                entry_price DECIMAL(10,5) NOT NULL,
                exit_price DECIMAL(10,5),
                stop_loss DECIMAL(10,5),
                take_profit DECIMAL(10,5),
                reasoning TEXT,
                voice_note_url TEXT,
                screenshot_url TEXT,
                result VARCHAR(20) DEFAULT 'pending',
                pips DECIMAL(8,2) DEFAULT 0,
                created_by VARCHAR(100) NOT NULL,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);

        console.log('Database tables initialized successfully');
    } catch (error) {
        console.error('Database initialization error:', error);
    }
}

// Initialize database on startup
initializeDatabase();

// Webhook endpoint for TradingView
app.post('/webhook/tradingview', async (req, res) => {
    try {
        console.log('Webhook received:', req.body);
        
        const expectedSecret = process.env.TRADINGVIEW_WEBHOOK_SECRET || 'webhook-secret-2024';
        const providedAuth = req.body.auth_token;
        
        if (!providedAuth) {
            return res.status(401).json({ error: 'Authentication token required' });
        }
        
        const result = await pool.query(`
            INSERT INTO signals (ticker, action, price, timestamp, received_at)
            VALUES ($1, $2, $3, $4, NOW())
            RETURNING *
        `, [
            req.body.ticker || 'UNKNOWN',
            req.body.action || 'buy',
            parseFloat(req.body.price) || 0,
            new Date(req.body.timestamp || Date.now())
        ]);
        
        const signal = result.rows[0];
        console.log('Signal processed:', signal);
        
        res.status(200).json({ 
            success: true, 
            message: 'Signal received and processed',
            signal_id: signal.id 
        });
        
    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// API endpoints
app.get('/api/signals', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM signals ORDER BY received_at DESC');
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching signals:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

app.post('/api/signals/:id/analyze', async (req, res) => {
    try {
        const { id } = req.params;
        const { user_name } = req.body;
        
        const signalResult = await pool.query('SELECT * FROM signals WHERE id = $1', [id]);
        if (signalResult.rows.length === 0) {
            return res.status(404).json({ error: 'Signal not found' });
        }
        
        const signal = signalResult.rows[0];
        if (signal.analyzed) {
            return res.status(400).json({ error: 'Signal already analyzed' });
        }
        
        const responseTime = (new Date() - new Date(signal.received_at)) / 1000;
        
        const updateResult = await pool.query(`
            UPDATE signals 
            SET analyzed = TRUE, analyzed_by = $1, analyzed_at = NOW(), response_time_seconds = $2
            WHERE id = $3
            RETURNING *
        `, [user_name || 'Anonymous', responseTime, id]);
        
        res.json({ 
            success: true, 
            signal: updateResult.rows[0],
            response_time_seconds: responseTime 
        });
        
    } catch (error) {
        console.error('Error analyzing signal:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

app.post('/api/trades', async (req, res) => {
    try {
        const result = await pool.query(`
            INSERT INTO trades (
                signal_id, pair, direction, entry_price, exit_price, 
                stop_loss, take_profit, reasoning, voice_note_url, 
                screenshot_url, result, pips, created_by
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            RETURNING *
        `, [
            req.body.signal_id || null,
            req.body.pair,
            req.body.direction,
            parseFloat(req.body.entry_price),
            req.body.exit_price ? parseFloat(req.body.exit_price) : null,
            req.body.stop_loss ? parseFloat(req.body.stop_loss) : null,
            req.body.take_profit ? parseFloat(req.body.take_profit) : null,
            req.body.reasoning || '',
            req.body.voice_note_url || null,
            req.body.screenshot_url || null,
            req.body.result || 'pending',
            parseFloat(req.body.pips) || 0,
            req.body.created_by || 'Anonymous'
        ]);
        
        res.json({ success: true, trade: result.rows[0] });
    } catch (error) {
        console.error('Error creating trade:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

app.get('/api/trades', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT t.*, s.ticker as signal_ticker 
            FROM trades t 
            LEFT JOIN signals s ON t.signal_id = s.id 
            ORDER BY t.created_at DESC
        `);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching trades:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

app.get('/api/leaderboard', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                analyzed_by as user,
                COUNT(*) as total_signals,
                AVG(response_time_seconds) as average_response_time,
                MIN(response_time_seconds) as fastest_response,
                MAX(response_time_seconds) as slowest_response
            FROM signals 
            WHERE analyzed = TRUE AND response_time_seconds IS NOT NULL
            GROUP BY analyzed_by
            ORDER BY average_response_time ASC
        `);
        
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching leaderboard:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

app.get('/health', async (req, res) => {
    try {
        const signalsResult = await pool.query('SELECT COUNT(*) FROM signals');
        const tradesResult = await pool.query('SELECT COUNT(*) FROM trades');
        
        res.json({ 
            status: 'healthy', 
            timestamp: new Date(),
            signals_count: parseInt(signalsResult.rows[0].count),
            trades_count: parseInt(tradesResult.rows[0].count),
            database: 'connected'
        });
    } catch (error) {
        res.status(500).json({ 
            status: 'unhealthy', 
            error: 'Database connection failed',
            timestamp: new Date()
        });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/test-webhook', async (req, res) => {
    console.log('Test webhook called');
    
    const testSignal = {
        ticker: 'EURUSD',
        action: 'buy',
        price: 1.0850,
        timestamp: new Date().toISOString(),
        auth_token: 'test-token'
    };
    
    try {
        const result = await pool.query(`
            INSERT INTO signals (ticker, action, price, timestamp, received_at)
            VALUES ($1, $2, $3, $4, NOW())
            RETURNING *
        `, [testSignal.ticker, testSignal.action, testSignal.price, new Date(testSignal.timestamp)]);
        
        res.json({ 
            message: 'Test signal created', 
            signal: result.rows[0] 
        });
    } catch (error) {
        console.error('Test webhook error:', error);
        res.status(500).json({ error: 'Failed to create test signal' });
    }
});

process.on('SIGINT', async () => {
    console.log('Shutting down gracefully...');
    await pool.end();
    process.exit(0);
});

app.listen(PORT, () => {
    console.log(`Trading Journal server running on port ${PORT}`);
    console.log(`Webhook URL: https://trading-journal-webhook1.vercel.app/webhook/tradingview`);
    console.log(`Dashboard: https://trading-journal-webhook1.vercel.app`);
    console.log('Database: PostgreSQL connected');
});
