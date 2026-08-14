// games/gameRegistry.js
const kaaliTeeri = require('./kaaliTeeri');

const GAMES = {
  kachuPhul: {
    name: 'Kachu Phul',
    description: 'Classic bidding card game',
    minPlayers: 2,
    maxPlayers: 7,
    handler: null, // handled inline in server.js (legacy)
  },
  kaaliTeeri: {
    name: 'Kaali Teeri',
    description: '3 of Spades — team bidding game',
    minPlayers: 4,
    maxPlayers: 6,
    allowedPlayerCounts: [4, 6],
    handler: kaaliTeeri,
  },
};

module.exports = { GAMES };
