const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());

// YAHAN apna copied link paste karo (password daal kar)
const MONGODB_URI = "mongodb://digitalprofiteges_db_user:V1UgKbzS1Y3PbdLT@ac-sdh6h6q-shard-00-00.vol3oe1.mongodb.net:27017,ac-sdh6h6q-shard-00-01.vol3oe1.mongodb.net:27017,ac-sdh6h6q-shard-00-02.vol3oe1.mongodb.net:27017/?ssl=true&replicaSet=atlas-k69mzp-shard-0&authSource=admin&appName=Cluster0";

mongoose.connect(MONGODB_URI)
    .then(() => console.log('MongoDB Connected Successfully!'))
    .catch((err) => console.log('MongoDB Connection Error: ', err));

app.get('/', (req, res) => {
    res.send('Driver Ride Picker Backend is Running!');
});

const PORT = 5000;
app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
});