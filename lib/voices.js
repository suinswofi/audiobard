'use strict';
// Kokoro voice packs. Grades are Kokoro's own quality ratings from its VOICES.md.
const VOICES = [
  { id: 'af_heart', name: 'Heart', accent: 'American', gender: 'Female', grade: 'A' },
  { id: 'af_bella', name: 'Bella', accent: 'American', gender: 'Female', grade: 'A-' },
  { id: 'af_nicole', name: 'Nicole', accent: 'American', gender: 'Female', grade: 'B-' },
  { id: 'af_aoede', name: 'Aoede', accent: 'American', gender: 'Female', grade: 'C+' },
  { id: 'af_kore', name: 'Kore', accent: 'American', gender: 'Female', grade: 'C+' },
  { id: 'af_sarah', name: 'Sarah', accent: 'American', gender: 'Female', grade: 'C+' },
  { id: 'af_nova', name: 'Nova', accent: 'American', gender: 'Female', grade: 'C' },
  { id: 'af_alloy', name: 'Alloy', accent: 'American', gender: 'Female', grade: 'C' },
  { id: 'af_sky', name: 'Sky', accent: 'American', gender: 'Female', grade: 'C-' },
  { id: 'af_jessica', name: 'Jessica', accent: 'American', gender: 'Female', grade: 'D' },
  { id: 'af_river', name: 'River', accent: 'American', gender: 'Female', grade: 'D' },
  { id: 'am_fenrir', name: 'Fenrir', accent: 'American', gender: 'Male', grade: 'C+' },
  { id: 'am_michael', name: 'Michael', accent: 'American', gender: 'Male', grade: 'C+' },
  { id: 'am_puck', name: 'Puck', accent: 'American', gender: 'Male', grade: 'C+' },
  { id: 'am_echo', name: 'Echo', accent: 'American', gender: 'Male', grade: 'D' },
  { id: 'am_eric', name: 'Eric', accent: 'American', gender: 'Male', grade: 'D' },
  { id: 'am_liam', name: 'Liam', accent: 'American', gender: 'Male', grade: 'D' },
  { id: 'am_onyx', name: 'Onyx', accent: 'American', gender: 'Male', grade: 'D' },
  { id: 'am_santa', name: 'Santa', accent: 'American', gender: 'Male', grade: 'D-' },
  { id: 'am_adam', name: 'Adam', accent: 'American', gender: 'Male', grade: 'F+' },
  { id: 'bf_emma', name: 'Emma', accent: 'British', gender: 'Female', grade: 'B-' },
  { id: 'bf_isabella', name: 'Isabella', accent: 'British', gender: 'Female', grade: 'C' },
  { id: 'bf_alice', name: 'Alice', accent: 'British', gender: 'Female', grade: 'D' },
  { id: 'bf_lily', name: 'Lily', accent: 'British', gender: 'Female', grade: 'D' },
  { id: 'bm_george', name: 'George', accent: 'British', gender: 'Male', grade: 'C' },
  { id: 'bm_fable', name: 'Fable', accent: 'British', gender: 'Male', grade: 'C' },
  { id: 'bm_lewis', name: 'Lewis', accent: 'British', gender: 'Male', grade: 'D+' },
  { id: 'bm_daniel', name: 'Daniel', accent: 'British', gender: 'Male', grade: 'D' },
];

module.exports = { VOICES };
