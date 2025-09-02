// server.js - Production Ready with PostgreSQL, SQLite, and Cloudinary support
require('dotenv').config();

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const cloudinary = require('cloudinary').v2;
const CloudinaryStorage = require('multer-storage-cloudinary');

const app = express();

// Environment variables with defaults
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const DATABASE_URL = process.env.DATABASE_URL || './electronics.db';
const UPLOAD_LIMIT = parseInt(process.env.UPLOAD_LIMIT) || 52428800; // 50MB
const UPLOADS_DIR = process.env.UPLOADS_DIR || './uploads';
const IMAGES_DIR = process.env.IMAGES_DIR || './uploads/images';
const FILES_DIR = process.env.FILES_DIR || './uploads/files';

// Cloudinary Configuration
const USE_CLOUDINARY = process.env.USE_CLOUDINARY === 'true' || NODE_ENV === 'production';
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;

console.log('🚀 Starting Electronics For Everyone Server...');
console.log(`📍 Environment: ${NODE_ENV}`);
console.log(`🔧 Port: ${PORT}`);
console.log(`💾 Database: ${DATABASE_URL}`);
console.log(`☁️ File Storage: ${USE_CLOUDINARY ? 'Cloudinary' : 'Local Filesystem'}`);

// Configure Cloudinary if enabled
if (USE_CLOUDINARY) {
    if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
        console.error('❌ Cloudinary configuration missing. Required: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET');
        process.exit(1);
    }
    
    // Configure Cloudinary with timeout settings
    cloudinary.config({
        cloud_name: CLOUDINARY_CLOUD_NAME,
        api_key: CLOUDINARY_API_KEY,
        api_secret: CLOUDINARY_API_SECRET,
        upload_timeout: 120000, // 2 minutes timeout
        chunk_size: 6000000 // 6MB chunks for large files
    });
    
    console.log(`☁️ Cloudinary configured: ${CLOUDINARY_CLOUD_NAME}`);
    
    // Test Cloudinary connection
    cloudinary.api.ping()
        .then(() => {
            console.log('✅ Cloudinary connection test successful');
            console.log('🔑 Cloudinary config check - Cloud name exists:', !!CLOUDINARY_CLOUD_NAME);
            console.log('🔑 Cloudinary config check - API key exists:', !!CLOUDINARY_API_KEY);
            console.log('🔑 Cloudinary config check - API secret exists:', !!CLOUDINARY_API_SECRET);
        })
        .catch(err => {
            console.error('❌ Cloudinary connection test failed:', err.message);
            console.error('📝 Full error:', err);
            console.error('🔍 Credentials status:');
            console.error('   CLOUDINARY_CLOUD_NAME:', CLOUDINARY_CLOUD_NAME ? 'SET' : 'MISSING');
            console.error('   CLOUDINARY_API_KEY:', CLOUDINARY_API_KEY ? 'SET' : 'MISSING');
            console.error('   CLOUDINARY_API_SECRET:', CLOUDINARY_API_SECRET ? 'SET' : 'MISSING');
        });
}

// Determine database type
const isPostgreSQL = DATABASE_URL.startsWith('postgres://') || DATABASE_URL.startsWith('postgresql://');
let db;

if (isPostgreSQL) {
    // PostgreSQL setup for production
    const { Pool } = require('pg');
    db = new Pool({
        connectionString: DATABASE_URL,
        ssl: NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    });
    console.log('🐘 Using PostgreSQL database');
} else {
    // SQLite setup for development
    const Database = require('better-sqlite3');
    db = new Database(DATABASE_URL);
    db.exec('PRAGMA journal_mode = WAL;');
    console.log('📁 Using SQLite database');
}

// Middleware
app.use(cors({
    origin: NODE_ENV === 'production' ? 
    (origin, callback) => {
        // Allow same-origin requests or specifically your domain
        if (!origin || origin === 'https://electronics-for-everyone.onrender.com') {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    } :
    ['http://localhost:3000', 'http://127.0.0.1:3000'],
    credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve static files
app.use(express.static('public'));
app.use('/uploads', express.static(UPLOADS_DIR));

// Create uploads directories (only for local storage)
const createDirectories = () => {
    if (!USE_CLOUDINARY) {
        const dirs = [UPLOADS_DIR, IMAGES_DIR, FILES_DIR];
        dirs.forEach(dir => {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
                console.log(`📁 Created directory: ${dir}`);
            }
        });
    }
};

createDirectories();

// Create table and setup database
const setupDatabase = async () => {
    if (isPostgreSQL) {
        try {
            await db.query(`
                CREATE TABLE IF NOT EXISTS components (
                    id SERIAL PRIMARY KEY,
                    name TEXT NOT NULL,
                    description TEXT NOT NULL,
                    image_path TEXT,
                    file_path TEXT NOT NULL,
                    original_filename TEXT NOT NULL,
                    file_size INTEGER,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            console.log('✅ PostgreSQL components table ready');
        } catch (err) {
            console.error('❌ PostgreSQL table creation error:', err.message);
        }
        console.log('✅ Connected to PostgreSQL database');
    } else {
        console.log('✅ Connected to SQLite database');

        // Create components table
        try {
            db.exec(`CREATE TABLE IF NOT EXISTS components (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                description TEXT NOT NULL,
                image_path TEXT,
                file_path TEXT NOT NULL,
                original_filename TEXT NOT NULL,
                file_size INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            console.log('✅ SQLite components table ready');
            
            // Check if file_size column exists, if not add it
            try {
                const result = db.prepare("PRAGMA table_info(components)").all();
                const hasFileSizeColumn = result.some(column => column.name === 'file_size');
                
                if (!hasFileSizeColumn) {
                    db.exec('ALTER TABLE components ADD COLUMN file_size INTEGER');
                    console.log('✅ Added file_size column to existing table');
                }
            } catch (alterErr) {
                console.log('ℹ️ file_size column migration check completed');
            }
        } catch (err) {
            console.error('❌ SQLite table creation error:', err.message);
        }
    }
};

setupDatabase();

// Multer configuration for file uploads
let storage;
let upload;

if (USE_CLOUDINARY) {
    // Use memory storage for Cloudinary uploads to avoid multer-storage-cloudinary issues
    storage = multer.memoryStorage();
} else {
    // Local storage configuration
    storage = multer.diskStorage({
        destination: (req, file, cb) => {
            if (file.fieldname === 'image') {
                cb(null, IMAGES_DIR);
            } else if (file.fieldname === 'cadFile') {
                cb(null, FILES_DIR);
            }
        },
        filename: (req, file, cb) => {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
            cb(null, file.fieldname + '-' + uniqueSuffix + '-' + sanitizedName);
        }
    });
}

upload = multer({
    storage: storage,
    limits: {
        fileSize: UPLOAD_LIMIT,
        files: 2
    },
    fileFilter: (req, file, cb) => {
        console.log(`📤 Starting upload for: ${file.originalname} (${file.mimetype})`);
        
        if (file.fieldname === 'image') {
            if (file.mimetype.startsWith('image/')) {
                cb(null, true);
            } else {
                cb(new Error('Only image files are allowed for images!'), false);
            }
        } else if (file.fieldname === 'cadFile') {
            const allowedExtensions = ['.dwg', '.dxf', '.step', '.stp', '.iges', '.igs', 
                                     '.f3d', '.ipt', '.asm', '.prt', '.sldprt', '.sldasm', 
                                     '.catpart', '.catproduct', '.3dm', '.skp', '.blend',
                                     '.obj', '.stl', '.ply', '.x3d', '.dae'];
            const fileExtension = path.extname(file.originalname).toLowerCase();
            
            if (allowedExtensions.includes(fileExtension)) {
                cb(null, true);
            } else {
                cb(new Error(`Invalid CAD file format: ${fileExtension}. Allowed: ${allowedExtensions.join(', ')}`), false);
            }
        } else {
            cb(new Error('Unexpected field'), false);
        }
    }
});

// Helper function to upload to Cloudinary with timeout
const uploadToCloudinary = (buffer, options) => {
    return new Promise((resolve, reject) => {
        const uploadTimeout = setTimeout(() => {
            reject(new Error(`Cloudinary upload timeout after ${options.timeout || 300000}ms`));
        }, options.timeout || 300000);

        const uploadStream = cloudinary.uploader.upload_stream(
            {
                resource_type: options.resource_type || 'raw',
                folder: options.folder,
                public_id: options.public_id,
                timeout: options.timeout || 300000,
                chunk_size: 6000000
            },
            (error, result) => {
                clearTimeout(uploadTimeout);
                if (error) {
                    console.error(`❌ Cloudinary upload error:`, error);
                    reject(error);
                } else {
                    console.log(`✅ Cloudinary upload successful: ${result.secure_url}`);
                    resolve(result);
                }
            }
        );

        uploadStream.end(buffer);
    });
};

// Add test endpoint to debug Cloudinary directly
if (USE_CLOUDINARY) {
    app.post('/api/test-cloudinary', (req, res) => {
        console.log('🧪 Testing Cloudinary upload directly...');
        
        // Test upload a small buffer to Cloudinary
        const testBuffer = Buffer.from('test file content', 'utf8');
        
        cloudinary.uploader.upload_stream(
            {
                resource_type: 'raw',
                folder: 'electronics-for-everyone/test',
                public_id: 'test-upload-' + Date.now()
            },
            (error, result) => {
                if (error) {
                    console.error('❌ Direct Cloudinary test failed:', error);
                    res.status(500).json({ error: 'Cloudinary test failed', details: error.message });
                } else {
                    console.log('✅ Direct Cloudinary test successful:', result.secure_url);
                    res.json({ success: true, url: result.secure_url });
                }
            }
        ).end(testBuffer);
    });
}

// Routes

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        environment: NODE_ENV,
        uptime: process.uptime()
    });
});

// Serve frontend in production
if (NODE_ENV === 'production') {
    app.get('/', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });
}

// Get all components
app.get('/api/components', async (req, res) => {
    const search = req.query.search || '';
    
    try {
        let rows;
        if (isPostgreSQL) {
            if (search) {
                const result = await db.query(
                    'SELECT * FROM components WHERE name ILIKE $1 OR description ILIKE $2 ORDER BY created_at DESC',
                    [`%${search}%`, `%${search}%`]
                );
                rows = result.rows;
            } else {
                const result = await db.query('SELECT * FROM components ORDER BY created_at DESC');
                rows = result.rows;
            }
        } else {
            if (search) {
                const stmt = db.prepare('SELECT * FROM components WHERE name LIKE ? OR description LIKE ? ORDER BY created_at DESC');
                rows = stmt.all(`%${search}%`, `%${search}%`);
            } else {
                const stmt = db.prepare('SELECT * FROM components ORDER BY created_at DESC');
                rows = stmt.all();
            }
        }
        
        console.log(`📊 Returned ${rows.length} components`);
        res.json(rows);
    } catch (err) {
        console.error('❌ Database query error:', err.message);
        res.status(500).json({ error: 'Database error occurred' });
    }
});

// Add new component with manual Cloudinary upload handling
app.post('/api/components', (req, res, next) => {
    console.log('🔄 Starting component upload process...');
    
    // Set timeout for the entire request (10 minutes)
    req.setTimeout(600000);
    res.setTimeout(600000);
    
    const uploadHandler = upload.fields([
        { name: 'image', maxCount: 1 },
        { name: 'cadFile', maxCount: 1 }
    ]);
    
    uploadHandler(req, res, async (err) => {
        if (err) {
            console.error('❌ Multer upload error:', err.message);
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(413).json({ 
                    error: 'File too large', 
                    details: `Maximum file size is ${(UPLOAD_LIMIT / 1024 / 1024).toFixed(2)}MB` 
                });
            }
            return res.status(400).json({ error: 'Upload error', details: err.message });
        }
        
        console.log('✅ Multer upload completed successfully');
        console.log('📝 Processing component:', req.body.name);
        
        const { name, description } = req.body;
        
        if (!name || !description) {
            return res.status(400).json({ 
                error: 'Name and description are required' 
            });
        }
        
        if (!req.files?.cadFile || req.files.cadFile.length === 0) {
            return res.status(400).json({ 
                error: 'CAD file is required' 
            });
        }
        
        // Log file information
        console.log('📋 Files received:');
        const cadFile = req.files.cadFile[0];
        console.log(`  📁 CAD File: ${cadFile.originalname}`);
        console.log(`     Size: ${((cadFile.size || 0) / 1024 / 1024).toFixed(2)}MB`);
        console.log(`     MIME: ${cadFile.mimetype}`);
        
        if (req.files.image && req.files.image.length > 0) {
            const imageFile = req.files.image[0];
            console.log(`  🖼️ Image: ${imageFile.originalname}`);
            console.log(`     Size: ${((imageFile.size || 0) / 1024 / 1024).toFixed(2)}MB`);
            console.log(`     MIME: ${imageFile.mimetype}`);
        }
        
        // Validate file sizes
        if (cadFile.size > UPLOAD_LIMIT) {
            return res.status(413).json({ 
                error: `CAD file too large: ${(cadFile.size / 1024 / 1024).toFixed(2)}MB. Maximum: ${(UPLOAD_LIMIT / 1024 / 1024).toFixed(2)}MB` 
            });
        }
        
        let imagePath = null;
        let filePath = null;
        
        try {
            if (USE_CLOUDINARY) {
                console.log('☁️ Starting Cloudinary uploads...');
                
                // Upload CAD file first (required)
                console.log('📁 Uploading CAD file to Cloudinary...');
                const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
                const sanitizedCadName = cadFile.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
                
                const cadUploadResult = await uploadToCloudinary(cadFile.buffer, {
                    resource_type: 'raw',
                    folder: 'electronics-for-everyone/files',
                    public_id: `cadFile-${uniqueSuffix}-${sanitizedCadName}`,
                    timeout: 300000 // 5 minutes for CAD files
                });
                
                filePath = cadUploadResult.secure_url;
                console.log(`✅ CAD file uploaded successfully: ${filePath}`);
                
                // Upload image if provided (optional)
                if (req.files.image && req.files.image.length > 0) {
                    console.log('🖼️ Uploading image to Cloudinary...');
                    const imageFile = req.files.image[0];
                    const sanitizedImageName = imageFile.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
                    const imageNameWithoutExt = sanitizedImageName.replace(/\.[^/.]+$/, '');
                    
                    const imageUploadResult = await uploadToCloudinary(imageFile.buffer, {
                        resource_type: 'image',
                        folder: 'electronics-for-everyone/images',
                        public_id: `image-${uniqueSuffix}-${imageNameWithoutExt}`,
                        timeout: 120000 // 2 minutes for images
                    });
                    
                    imagePath = imageUploadResult.secure_url;
                    console.log(`✅ Image uploaded successfully: ${imagePath}`);
                }
                
                console.log('🎉 All Cloudinary uploads completed successfully');
            } else {
                // Local storage paths
                imagePath = (req.files.image && req.files.image.length > 0) ? req.files.image[0].path : null;
                filePath = cadFile.path;
            }
            
            // Save to database
            console.log('💾 Saving component to database...');
            const originalFilename = cadFile.originalname;
            const fileSize = cadFile.size;
            
            let newComponent;
            if (isPostgreSQL) {
                const result = await db.query(
                    'INSERT INTO components (name, description, image_path, file_path, original_filename, file_size) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
                    [name, description, imagePath, filePath, originalFilename, fileSize]
                );
                newComponent = result.rows[0];
                console.log(`✅ Component saved to PostgreSQL with ID: ${newComponent.id}`);
            } else {
                const stmt = db.prepare('INSERT INTO components (name, description, image_path, file_path, original_filename, file_size) VALUES (?, ?, ?, ?, ?, ?)');
                const result = stmt.run(name, description, imagePath, filePath, originalFilename, fileSize);
                const getStmt = db.prepare('SELECT * FROM components WHERE id = ?');
                newComponent = getStmt.get(result.lastInsertRowid);
                console.log(`✅ Component saved to SQLite with ID: ${result.lastInsertRowid}`);
            }
            
            console.log('🎉 Component creation completed successfully!');
            console.log(`   Name: ${newComponent.name}`);
            console.log(`   ID: ${newComponent.id}`);
            console.log(`   File: ${newComponent.original_filename} (${((newComponent.file_size || 0) / 1024 / 1024).toFixed(2)}MB)`);
            
            res.json(newComponent);
            
        } catch (uploadError) {
            console.error('❌ Upload error:', uploadError.message);
            console.error('📝 Full error:', uploadError);
            
            if (uploadError.message.includes('timeout')) {
                return res.status(408).json({ 
                    error: 'Upload timeout', 
                    details: 'The file upload took too long. Please try with a smaller file or try again later.' 
                });
            }
            
            return res.status(500).json({ 
                error: 'Failed to upload files', 
                details: uploadError.message 
            });
        }
    });
});

// Download component file
app.get('/api/download/:id', async (req, res) => {
    const componentId = req.params.id;
    console.log(`📥 Download request for component ID: ${componentId}`);
    
    try {
        let row;
        if (isPostgreSQL) {
            const result = await db.query('SELECT * FROM components WHERE id = $1', [componentId]);
            row = result.rows[0];
        } else {
            const stmt = db.prepare('SELECT * FROM components WHERE id = ?');
            row = stmt.get(componentId);
        }
        
        if (!row) {
            res.status(404).json({ error: 'Component not found' });
            return;
        }
        
        if (USE_CLOUDINARY) {
            // For Cloudinary, redirect to the direct URL
            console.log(`✅ Redirecting to Cloudinary URL: ${row.original_filename}`);
            res.setHeader('Content-Disposition', `attachment; filename="${row.original_filename}"`);
            res.redirect(row.file_path);
        } else {
            // For local storage
            const filePath = path.resolve(row.file_path);
            
            if (!fs.existsSync(filePath)) {
                console.error(`❌ File not found: ${filePath}`);
                res.status(404).json({ error: 'File not found on server' });
                return;
            }
            
            console.log(`✅ Downloading: ${row.original_filename}`);
            res.download(filePath, row.original_filename);
        }
    } catch (err) {
        console.error('❌ Database error:', err.message);
        res.status(500).json({ error: 'Database error' });
    }
});

// Delete component
app.delete('/api/components/:id', async (req, res) => {
    const componentId = req.params.id;
    console.log(`🗑️ Delete request for component ID: ${componentId}`);
    
    try {
        let row;
        if (isPostgreSQL) {
            const result = await db.query('SELECT * FROM components WHERE id = $1', [componentId]);
            row = result.rows[0];
        } else {
            const stmt = db.prepare('SELECT * FROM components WHERE id = ?');
            row = stmt.get(componentId);
        }
        
        if (!row) {
            res.status(404).json({ error: 'Component not found' });
            return;
        }
        
        // Delete files
        if (USE_CLOUDINARY) {
            // Delete from Cloudinary
            const deletePromises = [];
            
            if (row.image_path) {
                // Extract public ID from Cloudinary URL
                const urlParts = row.image_path.split('/');
                const imagePublicId = `electronics-for-everyone/images/${urlParts[urlParts.length - 1].split('.')[0]}`;
                deletePromises.push(
                    cloudinary.uploader.destroy(imagePublicId)
                        .then(() => console.log(`🗑️ Deleted Cloudinary image: ${imagePublicId}`))
                        .catch(err => console.error(`❌ Cloudinary image delete error: ${err.message}`))
                );
            }
            
            if (row.file_path) {
                // Extract public ID from Cloudinary URL for raw files
                const urlParts = row.file_path.split('/');
                const fileName = urlParts[urlParts.length - 1];
                const filePublicId = `electronics-for-everyone/files/${fileName}`;
                deletePromises.push(
                    cloudinary.uploader.destroy(filePublicId, { resource_type: 'raw' })
                        .then(() => console.log(`🗑️ Deleted Cloudinary file: ${filePublicId}`))
                        .catch(err => console.error(`❌ Cloudinary file delete error: ${err.message}`))
                );
            }
            
            await Promise.all(deletePromises);
        } else {
            // Delete from local filesystem
            if (row.image_path && fs.existsSync(row.image_path)) {
                fs.unlinkSync(row.image_path);
                console.log(`🗑️ Deleted image: ${row.image_path}`);
            }
            if (row.file_path && fs.existsSync(row.file_path)) {
                fs.unlinkSync(row.file_path);
                console.log(`🗑️ Deleted file: ${row.file_path}`);
            }
        }
        
        // Delete from database
        if (isPostgreSQL) {
            await db.query('DELETE FROM components WHERE id = $1', [componentId]);
        } else {
            const deleteStmt = db.prepare('DELETE FROM components WHERE id = ?');
            deleteStmt.run(componentId);
        }
        
        console.log(`✅ Component ${componentId} deleted successfully`);
        res.json({ message: 'Component deleted successfully' });
    } catch (err) {
        console.error('❌ Database delete error:', err.message);
        res.status(500).json({ error: 'Failed to delete component' });
    }
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('❌ Server error:', error.message);
    console.error('📝 Error stack:', error.stack);
    
    // Check if it's a Cloudinary error
    if (error.message && error.message.includes('cloudinary')) {
        console.error('☁️ Cloudinary error details:', error);
        return res.status(500).json({ error: 'Cloudinary upload failed: ' + error.message });
    }
    
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ 
                error: `File too large. Maximum size is ${UPLOAD_LIMIT / 1024 / 1024}MB` 
            });
        }
        return res.status(400).json({ error: error.message });
    }
    
    res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// Start server
app.listen(PORT, () => {
    console.log(`🌟 Server running on port ${PORT}`);
    console.log(`🌐 Access your site at: http://localhost:${PORT}`);
    console.log('📚 Electronics For Everyone is ready!');
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down gracefully...');
    try {
        if (isPostgreSQL) {
            await db.end();
            console.log('✅ PostgreSQL connection closed');
        } else {
            db.close();
            console.log('✅ SQLite database connection closed');
        }
    } catch (err) {
        console.error('❌ Database close error:', err.message);
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('🛑 SIGTERM received, shutting down...');
    try {
        if (isPostgreSQL) {
            await db.end();
        } else {
            db.close();
        }
    } catch (err) {
        console.error('❌ Database close error:', err.message);
    }
    process.exit(0);
});