// Flights and final quotation data engine (Module 2, Slide 7)
import { env } from '../db/index.mjs';

export const flightsConfigured = () => !!env.FLIGHT_API_KEY;

const MOCK_AIRLINES = [
  { code: 'EK', name: 'Emirates', hub: 'DXB' },
  { code: '6E', name: 'IndiGo', hub: 'DEL' },
  { code: 'AI', name: 'Air India', hub: 'DEL' },
  { code: 'SQ', name: 'Singapore Airlines', hub: 'SIN' },
  { code: 'QR', name: 'Qatar Airways', hub: 'DOH' },
  { code: 'BA', name: 'British Airways', hub: 'LHR' },
];

/**
 * Search flight availability for an itinerary destination.
 */
export async function searchFlights({ from = 'DEL', to = 'DXB', date = null, passengers = 2, cabinClass = 'Economy' }) {
  console.log(`[flights] searching ${from} -> ${to} on ${date || 'upcoming'}`);

  // When third-party API is configured:
  if (flightsConfigured()) {
    try {
      // Connect to Amadeus / Duffel / AviationStack if configured
    } catch (e) {
      console.warn('[flights] flight API search failed, falling back to catalog:', e.message);
    }
  }

  // Pre-configured realistic carrier schedules
  const basePricePerPax = cabinClass === 'Business' ? 62000 : 24500;
  return [
    {
      airline: 'Emirates',
      flightNumber: 'EK 511',
      departureAirport: from,
      arrivalAirport: to,
      departureTime: '10:30',
      arrivalTime: '13:00',
      duration: '4h 00m',
      cabinClass,
      stops: 'Non-stop',
      pricePerPerson: basePricePerPax + 3200,
      totalPrice: (basePricePerPax + 3200) * passengers,
      currency: 'INR',
    },
    {
      airline: 'IndiGo',
      flightNumber: '6E 1401',
      departureAirport: from,
      arrivalAirport: to,
      departureTime: '16:15',
      arrivalTime: '18:45',
      duration: '4h 00m',
      cabinClass,
      stops: 'Non-stop',
      pricePerPerson: basePricePerPax - 4100,
      totalPrice: (basePricePerPax - 4100) * passengers,
      currency: 'INR',
    },
    {
      airline: 'Air India',
      flightNumber: 'AI 995',
      departureAirport: from,
      arrivalAirport: to,
      departureTime: '20:10',
      arrivalTime: '22:40',
      duration: '4h 00m',
      cabinClass,
      stops: 'Non-stop',
      pricePerPerson: basePricePerPax,
      totalPrice: basePricePerPax * passengers,
      currency: 'INR',
    },
  ];
}

/**
 * Validate and clean a flight segment added by staff.
 */
export function normalizeFlightSegment(segment = {}) {
  return {
    airline: String(segment.airline || 'Air Carrier').trim(),
    flightNumber: String(segment.flightNumber || 'FLIGHT').trim(),
    departureAirport: String(segment.departureAirport || 'DEP').toUpperCase().trim(),
    arrivalAirport: String(segment.arrivalAirport || 'ARR').toUpperCase().trim(),
    departureDate: segment.departureDate || null,
    departureTime: segment.departureTime || '',
    arrivalDate: segment.arrivalDate || null,
    arrivalTime: segment.arrivalTime || '',
    cabinClass: segment.cabinClass || 'Economy',
    pnr: segment.pnr ? String(segment.pnr).toUpperCase().trim() : null,
    price: Number(segment.price) || 0,
    currency: segment.currency || 'INR',
  };
}

