// Firebase configuration for Fe2O3 Scouting App
const firebaseConfig = {
  apiKey: "AIzaSyBaW2eJbbazBTDD15fkOmWyGpspuFXMMlY",
  authDomain: "scouting-app-9b4c4.firebaseapp.com",
  projectId: "scouting-app-9b4c4",
  storageBucket: "scouting-app-9b4c4.firebasestorage.app",
  messagingSenderId: "544953538512",
  appId: "1:544953538512:web:3a0fa247b5da0d3cff8bd5",
  measurementId: "G-J4LNYH08HL"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

// Enable offline persistence (important for tournament use with spotty WiFi)
db.enablePersistence({ synchronizeTabs: true }).catch(err => {
  console.warn('Firestore persistence:', err.code);
});