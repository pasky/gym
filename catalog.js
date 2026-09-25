// Source of truth for the exercise library (edit here, not in the app).
// The app only stores sessions, per-exercise target overrides and notes in the browser (keyed by
// exercise id), so changes here propagate. Keep ids stable.
//
// Exercise fields:
//   group: muscle group bucket (see groups below), used to balance visits
//   target: default prescription { sets, reps (or seconds for holds), load kg|null, rest s } (user can override in-app)
//   ss: superset tag; consecutive exercises with the same tag in a visit are done back-to-back (no rest between)
//   kind: 'reps' | 'hold' (hold => the "reps" number is seconds)
//   perSide: reps/holds are per side
//   loadType: 'kg' (external load), 'bw' (bodyweight, optional added kg), 'none'
//   step: default progression increment (kg, or seconds for holds)
//   primary/secondary: atomic muscle names (reuse existing spellings; they're aggregated in the balance view)
//   sheet: muscles as listed on the trainer's sheet; review: notes from checking the sheet
window.CATALOG = {
  groups: [
    { id: 'legs', name: 'Legs & glutes' },
    { id: 'back', name: 'Back (pull)' },
    { id: 'chest', name: 'Chest (push)' },
    { id: 'shoulders', name: 'Shoulders & arms' },
    { id: 'core', name: 'Core' },
  ],
  exercises: [
    // ---- Training A ----
    {
      id: 'goblet-step-up', group: 'legs', target: { sets: 3, reps: 8, load: 6, rest: 90 },
      name: 'Goblet step-up', detail: '45 cm box, weight held at chest',
      img: 'img/ex/goblet-step-up.jpg', kind: 'reps', perSide: true, loadType: 'kg', step: 2,
      primary: ['Quads', 'Glutes'], secondary: ['Adductors', 'Hamstrings', 'Calves', 'Core'],
      sheet: 'Quads, glutes, calves',
      review: 'Calves are only a minor stabiliser, not a main focus. The diagram highlights hamstrings heavily, barely shows glutes, and leaves calves grey even though it lists them.',
      tips: ['Drive through the whole foot.', 'Keep your chest up and core tight.', 'Control the movement.'],
    },
    {
      id: 'goblet-box-squat', group: 'legs', target: { sets: 3, reps: 8, load: 12, rest: 90 },
      name: 'Goblet box squat', detail: '45 cm box',
      img: 'img/ex/goblet-box-squat.jpg', kind: 'reps', perSide: false, loadType: 'kg', step: 2,
      primary: ['Quads', 'Glutes'], secondary: ['Adductors', 'Hamstrings', 'Core'],
      sheet: 'Quads, glutes',
      review: 'Muscle list is correct. The diagram over-emphasises hamstrings vs glutes. "Drive through your heels" is a dated cue: use even whole-foot pressure, and touch the box without dropping onto it.',
      tips: ['Sit back and touch the box.', 'Drive through your heels.', 'Keep your core tight and chest up.'],
    },
    {
      id: 'seated-cable-row', group: 'back', target: { sets: 3, reps: 10, load: 25, rest: 90 }, ss: 'row-facepull',
      name: 'Seated cable row', detail: 'Superset with face pull',
      img: 'img/ex/seated-cable-row.jpg', kind: 'reps', perSide: false, loadType: 'kg', step: 2.5,
      primary: ['Lats', 'Rhomboids', 'Mid traps'], secondary: ['Rear delts', 'Biceps', 'Core'],
      sheet: 'Back, rear delts (shared with face pull)',
      review: 'Diagram is wrong: it highlights the front waist/abdomen instead of the back, and the mid-back is left blank. The row mainly works lats + mid-back; rear delts are secondary.',
      tips: ['Pull your shoulder blades back and down.', 'Squeeze your back at the end.', 'Control the movement.'],
    },
    {
      id: 'face-pull', group: 'back', target: { sets: 3, reps: 12, load: 10, rest: 90 }, ss: 'row-facepull',
      name: 'Face pull', detail: 'Cable, rope attachment',
      img: 'img/ex/face-pull.jpg', kind: 'reps', perSide: false, loadType: 'kg', step: 2.5,
      primary: ['Rear delts', 'Rhomboids', 'Mid traps', 'Rotator cuff'], secondary: ['Biceps'],
      sheet: 'Back, rear delts (shared with seated row)',
      review: 'Front-view diagram highlights chest and front delts. That\'s wrong, since face pulls work the opposite side. Scapular retractors are under-highlighted. The sheet gives no rest for the superset (~90 s after the face pull is assumed).',
      tips: ['Pull towards your face.', 'Keep elbows high (comfortably).', 'Squeeze your shoulder blades.'],
    },
    {
      id: 'curl-to-press', group: 'shoulders', target: { sets: 3, reps: 8, load: 6, rest: 90 },
      name: 'Biceps curl into shoulder press', detail: 'Dumbbells, weight is per hand',
      img: 'img/ex/curl-to-press.jpg', kind: 'reps', perSide: false, loadType: 'kg', step: 1,
      primary: ['Biceps', 'Front delts', 'Side delts', 'Triceps'], secondary: ['Upper traps', 'Serratus', 'Core'],
      sheet: 'Biceps, shoulders',
      review: 'Triceps are missing from the list, even though they lock out the press. Shoulders are only faintly highlighted. "2x 6 kg each hand" means one 6 kg dumbbell in each hand.',
      tips: ['Curl the weights up.', 'Press overhead with control.', 'Keep your core tight.'],
    },
    {
      id: 'cable-trunk-twist', group: 'core', target: { sets: 3, reps: 10, load: 7.5, rest: 90 },
      name: 'Cable trunk twist', detail: 'Med ball on the chest',
      img: 'img/ex/cable-trunk-twist.jpg', kind: 'reps', perSide: true, loadType: 'kg', step: 2.5,
      primary: ['Obliques'], secondary: ['Rectus abdominis', 'Transverse abdominis', 'Hip rotators'],
      sheet: 'Core, obliques',
      review: 'Diagram is wrong: it highlights the front hips/upper thighs instead of the obliques/abs. 7.5 kg is presumably the cable stack, and the med ball weight isn\'t specified. The two photos show the cable from opposite sides (one per side).',
      tips: ['Rotate your torso, not your arms.', 'Keep the med ball at chest level.', 'Control the movement and squeeze your core.'],
    },
    // ---- Training B ----
    {
      id: 'isometric-lunge', group: 'legs', target: { sets: 3, reps: 20, load: null, rest: 60 },
      name: 'Isometric lunge', detail: 'Inside ankle high, pressure on the outside of the foot',
      img: 'img/ex/isometric-lunge.jpg', kind: 'hold', perSide: true, loadType: 'none', step: 5,
      primary: ['Quads', 'Glutes'], secondary: ['Adductors', 'Foot arch', 'Calves', 'Core'],
      sheet: 'Quads, glutes, adductors',
      review: 'Adductors are secondary at best. The "inside ankle high / outside of the foot" cue targets the foot arch and ankle (tibialis posterior), which isn\'t shown. Glutes aren\'t highlighted. In the photo the rear knee seems to rest on the floor; hover it to keep the hold loaded. Presumably 20 s per side. Don\'t roll fully onto the outer edge; keep big-toe contact.',
      tips: ['Keep the inside ankle high.', 'Put the pressure to the outside of the foot.', 'Stay upright and engaged.'],
    },
    {
      id: 'bulgarian-split-squat', group: 'legs', target: { sets: 3, reps: 8, load: null, rest: 90 },
      name: 'Bulgarian split squat', detail: 'Rear foot on bench; inside ankle high, pressure on the outside of the foot',
      img: 'img/ex/bulgarian-split-squat.jpg', kind: 'reps', perSide: true, loadType: 'bw', step: 2,
      primary: ['Quads', 'Glutes'], secondary: ['Adductors', 'Hamstrings', 'Glute med', 'Foot arch', 'Core'],
      sheet: 'Quads, glutes, hamstrings',
      review: 'Hamstrings are secondary, not a main focus. The diagram highlights only the quads and feet, with no glutes or hamstrings. The sheet omits "each side", but 8 reps is surely per leg.',
      tips: ['Keep the inside ankle high.', 'Put the pressure to the outside of the foot.', 'Control the movement.'],
    },
    {
      id: 'kinesis-chest-press', group: 'chest', target: { sets: 3, reps: 10, load: 5, rest: 60 },
      name: 'Chest press', detail: 'Kinesis machine, standing',
      img: 'img/ex/kinesis-chest-press.jpg', kind: 'reps', perSide: false, loadType: 'kg', step: 2.5,
      primary: ['Chest'], secondary: ['Front delts', 'Triceps', 'Serratus', 'Core'],
      sheet: 'Chest, shoulders, triceps',
      review: 'List and diagram are OK ("shoulders" = front delts). Unclear whether 5 kg is per cable.',
      tips: ['Keep your core tight and chest up.', 'Press forward and squeeze the chest.', 'Control the movement.'],
    },
    {
      id: 'lat-pulldown', group: 'back', target: { sets: 3, reps: 10, load: 35, rest: 90 },
      name: 'Lat pulldown', detail: 'Grip a little wider than shoulder width',
      img: 'img/ex/lat-pulldown.jpg', kind: 'reps', perSide: false, loadType: 'kg', step: 2.5,
      primary: ['Lats', 'Teres major'], secondary: ['Biceps', 'Mid traps', 'Lower traps', 'Rhomboids', 'Rear delts'],
      sheet: 'Lats, mid back, biceps',
      review: 'List is OK. Diagram is wrong: it highlights the front abdomen instead of the lats on the back, and biceps aren\'t highlighted. Pull the bar to the upper chest (not behind the neck).',
      tips: ['Pull elbows down and back.', 'Squeeze your lats at the bottom.', 'Control the movement.'],
    },
    {
      id: 'deadbug-hold', group: 'core', target: { sets: 3, reps: 10, load: null, rest: 60 },
      name: 'Deadbug isometric hold', detail: 'Palms pressed against thighs, 3 s hold per rep',
      img: 'img/ex/deadbug-hold.jpg', kind: 'reps', perSide: false, loadType: 'none', step: 1,
      primary: ['Rectus abdominis', 'Transverse abdominis', 'Obliques'], secondary: ['Hip flexors'],
      sheet: 'Abs, core',
      review: 'Diagram is wrong: it highlights the front thighs instead of the abs. The 2nd photo shows one leg extending (a regular deadbug rep), not a pure hold. Ask whether 10 reps is total or per side.',
      tips: ['Keep your lower back pressed into the floor.', 'Press your palms against your thighs.', 'Stay stable and breathe.'],
    },
    // ---- added later ----
    {
      id: 'side-plank-hip-lift', group: 'core', target: { sets: 3, reps: 10, load: null, rest: 60 },
      name: 'Side plank hip lifts', detail: 'Kneeling side plank on forearm: bottom knee bent, top leg straight, top hand on hip',
      img: null, kind: 'reps', perSide: true, loadType: 'none', step: 1,
      primary: ['Obliques', 'Glute med'], secondary: ['Quadratus lumborum', 'Transverse abdominis', 'Serratus', 'Rotator cuff'],
      tips: ['Elbow right under the shoulder, push the floor away.', 'Hips stacked; at the top, knee–hip–shoulder in one line.', 'Lift from the side waist, lower with control. Tap, don\'t flop.'],
    },
  ],
  // The trainer's original sheets (shown on the Data tab). Visits can mix any exercises.
  plans: [
    { id: 'A', name: 'Training A', sheet: 'img/sheets/training-a.jpg',
      ex: ['goblet-step-up', 'goblet-box-squat', 'seated-cable-row', 'face-pull', 'curl-to-press', 'cable-trunk-twist'] },
    { id: 'B', name: 'Training B', sheet: 'img/sheets/training-b.jpg',
      ex: ['isometric-lunge', 'bulgarian-split-squat', 'kinesis-chest-press', 'lat-pulldown', 'deadbug-hold'] },
  ],
};
