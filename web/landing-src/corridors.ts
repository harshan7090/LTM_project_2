/* The fifteen corridors, generated from src/integrity/routes.py.
 *
 * The same waypoints the 5,000 segments were placed on, so the landing
 * page and the console are drawing the same network rather than two
 * versions of it. The console fetches these from /api/map/routes; the
 * landing is public and unauthenticated, so it carries a copy.
 *
 * Generated - do not hand-edit.
 */
export interface Corridor {
  name: string; zone: string; km: number; weight: number;
  /** [latitude, longitude] in flow order. */
  path: [number, number][];
}

export const CORRIDORS: Corridor[] = [
  { name: "HVJ West Leg", zone: "Western", km: 682, weight: 1.0, path: [[21.12,72.64], [21.63,73.00], [22.31,73.18], [22.78,73.61], [23.33,75.04], [24.51,77.80]] },
  { name: "Dahej\u2013Vadodara (DVPL)", zone: "Western", km: 112, weight: 0.5, path: [[21.70,72.58], [21.71,72.99], [22.31,73.18]] },
  { name: "Mumbai\u2013Pune\u2013Solapur", zone: "Western", km: 358, weight: 0.6, path: [[19.08,72.88], [18.99,73.12], [18.52,73.86], [17.66,75.91]] },
  { name: "Jamnagar\u2013Loni LPG", zone: "Northern", km: 612, weight: 1.0, path: [[24.58,73.68], [26.45,74.64], [26.91,75.79], [27.55,76.63], [28.75,77.29]] },
  { name: "HVJ East Leg", zone: "Northern", km: 537, weight: 0.8, path: [[24.51,77.80], [26.22,78.18], [26.47,79.51], [26.45,80.33], [26.07,81.52]] },
  { name: "Panipat\u2013Jammu", zone: "Northern", km: 441, weight: 0.5, path: [[29.39,76.97], [30.38,76.78], [30.90,75.86], [31.33,75.58], [32.73,74.87]] },
  { name: "Paradip\u2013Haldia", zone: "Eastern", km: 426, weight: 1.0, path: [[20.32,86.61], [20.46,85.88], [21.49,86.93], [22.35,87.32], [22.03,88.09]] },
  { name: "Haldia\u2013Barauni", zone: "Eastern", km: 483, weight: 0.7, path: [[22.03,88.09], [22.57,88.36], [23.52,87.31], [24.63,86.99], [25.47,85.97]] },
  { name: "Dhamra\u2013Jharsuguda", zone: "Eastern", km: 366, weight: 0.45, path: [[20.79,86.98], [21.06,86.51], [20.84,85.10], [21.86,84.01]] },
  { name: "Kochi\u2013Mangalore (KKBMPL)", zone: "Southern", km: 378, weight: 1.0, path: [[9.93,76.27], [10.53,76.21], [10.74,76.25], [11.26,75.78], [11.87,75.37], [12.91,74.86]] },
  { name: "Chennai\u2013Madurai", zone: "Southern", km: 421, weight: 0.7, path: [[13.08,80.27], [11.94,79.49], [10.79,78.70], [9.93,78.12]] },
  { name: "Visakhapatnam\u2013Hyderabad", zone: "Southern", km: 553, weight: 0.6, path: [[17.69,83.22], [17.00,81.80], [16.51,80.65], [17.39,78.49]] },
  { name: "Numaligarh\u2013Siliguri", zone: "North Eastern", km: 549, weight: 1.0, path: [[26.62,93.74], [26.63,92.80], [26.14,91.74], [26.48,90.55], [26.72,88.43]] },
  { name: "Digboi\u2013Numaligarh", zone: "North Eastern", km: 229, weight: 0.55, path: [[27.39,95.62], [27.47,94.91], [26.98,94.64], [26.62,93.74]] },
  { name: "Guwahati\u2013Silchar", zone: "North Eastern", km: 266, weight: 0.45, path: [[26.14,91.74], [26.35,92.68], [25.57,92.80], [24.83,92.78]] },
];

export const TOTAL_KM = 6414;
