// Arranque local: "npm start" y abrir http://localhost:3000
// (En Vercel no se usa este archivo: la plataforma arranca api/server.js.)
import server from './api/server.js';

const puerto = Number(process.env.PORT) || 3000;
server.listen(puerto, () => {
  console.log(`Chat disponible en http://localhost:${puerto}`);
});
