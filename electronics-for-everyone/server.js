// server.js
const express = require('express');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Create uploads directories
const createDirectories = () => {
    const dirs = ['uploads/images', 'uploads/files'];
    dirs.forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });
};

createDirectories();

// Database setup
const db = new sqlite3.Database('electronics.db');

// Create components table
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS components (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        image_path TEXT,
        file_path TEXT NOT NULL,
        original_filename TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// Multer configuration for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (file.fieldname === 'image') {
            cb(null, 'uploads/images/');
        } else if (file.fieldname === 'cadFile') {
            cb(null, 'uploads/files/');
        }
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 50 * 1024 * 1024 // 50MB limit
    },
    fileFilter: (req, file, cb) => {
        if (file.fieldname === 'image') {
            // Accept image files
            if (file.mimetype.startsWith('image/')) {
                cb(null, true);
            } else {
                cb(new Error('Only image files are allowed for images!'), false);
            }
        } else if (file.fieldname === 'cadFile') {
            // Accept CAD files and common formats
            const allowedExtensions = ['.dwg', '.dxf', '.step', '.stp', '.iges', '.igs', 
                                     '.f3d', '.ipt', '.asm', '.prt', '.sldprt', '.sldasm', 
                                     '.catpart', '.catproduct', '.3dm', '.skp', '.blend'];
            const fileExtension = path.extname(file.originalname).toLowerCase();
            
            if (allowedExtensions.includes(fileExtension)) {
                cb(null, true);
            } else {
                cb(new Error('Invalid CAD file format!'), false);
            }
        } else {
            cb(new Error('Unexpected field'), false);
        }
    }
});

// Routes

// Get all components
app.get('/api/components', (req, res) => {
    const search = req.query.search || '';
    const query = search ? 
        'SELECT * FROM components WHERE name LIKE ? OR description LIKE ? ORDER BY created_at DESC' :
        'SELECT * FROM components ORDER BY created_at DESC';
    
    const params = search ? [`%${search}%`, `%${search}%`] : [];
    
    db.all(query, params, (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows);
    });
});

// Add new component
app.post('/api/components', upload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'cadFile', maxCount: 1 }
]), (req, res) => {
    const { name, description } = req.body;
    
    if (!name || !description || !req.files.cadFile) {
        return res.status(400).json({ error: 'Name, description, and CAD file are required' });
    }
    
    const imagePath = req.files.image ? req.files.image[0].path : null;
    const filePath = req.files.cadFile[0].path;
    const originalFilename = req.files.cadFile[0].originalname;
    
    db.run(
        'INSERT INTO components (name, description, image_path, file_path, original_filename) VALUES (?, ?, ?, ?, ?)',
        [name, description, imagePath, filePath, originalFilename],
        function(err) {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            
            // Return the new component
            db.get('SELECT * FROM components WHERE id = ?', [this.lastID], (err, row) => {
                if (err) {
                    res.status(500).json({ error: err.message });
                    return;
                }
                res.json(row);
            });
        }
    );
});

// Download component file
app.get('/api/download/:id', (req, res) => {
    const componentId = req.params.id;
    
    db.get('SELECT * FROM components WHERE id = ?', [componentId], (err, row) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        
        if (!row) {
            res.status(404).json({ error: 'Component not found' });
            return;
        }
        
        const filePath = path.resolve(row.file_path);
        
        if (!fs.existsSync(filePath)) {
            res.status(404).json({ error: 'File not found' });
            return;
        }
        
        res.download(filePath, row.original_filename);
    });
});

// Delete component (optional)
app.delete('/api/components/:id', (req, res) => {
    const componentId = req.params.id;
    
    // First get the component to delete files
    db.get('SELECT * FROM components WHERE id = ?', [componentId], (err, row) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        
        if (!row) {
            res.status(404).json({ error: 'Component not found' });
            return;
        }
        
        // Delete files
        if (row.image_path && fs.existsSync(row.image_path)) {
            fs.unlinkSync(row.image_path);
        }
        if (row.file_path && fs.existsSync(row.file_path)) {
            fs.unlinkSync(row.file_path);
        }
        
        // Delete from database
        db.run('DELETE FROM components WHERE id = ?', [componentId], (err) => {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            res.json({ message: 'Component deleted successfully' });
        });
    });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log('Electronics For Everyone CAD Library Backend Started!');
});

// Graceful shutdown
process.on('SIGINT', () => {
    db.close((err) => {
        if (err) {
            console.error(err.message);
        }
        console.log('Database connection closed.');
        process.exit(0);
    });
});