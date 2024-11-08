
const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 5000;

//allows communication with frontend
app.use(cors());

app.use(express.json());

// Test route to see if server is working
app.get('/api/test', (req, res) => {
  res.json({ message: "Hello from the backend!" });
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
