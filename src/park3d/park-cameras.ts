// Metres relative to the room lawn. The fixed projector rigs never use these.
export const PARK_VIEWS = [
  { label: "Project lawn", radius: 20, height: 5.2, lookY: 3.3, targetX: 0, targetZ: 0, angle: 0 },
  { label: "The Pond", radius: 44, height: 10, lookY: -2, targetX: -6, targetZ: -88, angle: -.22 },
  { label: "Park overlook", radius: 155, height: 98, lookY: 8, targetX: 10, targetZ: -120, angle: .32 },
] as const;
