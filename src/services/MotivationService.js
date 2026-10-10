/**
 * MotivationService
 * -----------------------------------------------------------------------
 * A small pool of short English quotes/language-facts (with Arabic
 * translation) shown after finishing a session - unpredictable rather
 * than a fixed "well done" message, which is what makes it a genuine
 * "variable reward" rather than routine positive feedback. Deliberately
 * plain-text originals here (not attributed to named people) to avoid
 * any copyright/attribution risk in an app that gets rebuilt and shared.
 */
const POOL = [
  { en: "A different language is a different vision of life.", ar: "لغة مختلفة يعني رؤية مختلفة للحياة." },
  { en: "The limits of my language mean the limits of my world.", ar: "حدود لغتي هي حدود عالمي." },
  { en: "Learning never exhausts the mind.", ar: "التعلم مبيتعبش العقل، بيغذّيه." },
  { en: "Fun fact: English has more words than any other language, over a million.", ar: "معلومة: الإنجليزي عنده أكتر من مليون كلمة، أكتر من أي لغة تانية." },
  { en: "The word 'set' has the most different meanings in English.", ar: "كلمة set عندها أكتر معاني مختلفة في الإنجليزي كله." },
  { en: "Fun fact: 'Dreamt' is the only English word ending in 'mt'.", ar: "معلومة: كلمة dreamt هي الكلمة الوحيدة في الإنجليزي اللي بتخلص بـ mt." },
  { en: "Small daily progress adds up to big results.", ar: "التقدم الصغير اليومي بيتجمع ويبقى نتيجة كبيرة." },
  { en: "Consistency beats intensity.", ar: "الاستمرارية أقوى من الاندفاع المؤقت." },
  { en: "You don't have to be great to start, you have to start to be great.", ar: "مش لازم تبقى محترف عشان تبدأ، لازم تبدأ عشان تبقى محترف." },
  { en: "Practice doesn't make perfect, practice makes permanent.", ar: "التدريب مبيخليكش مثالي، بيخلي اللي اتعلمته ثابت." },
  { en: "Fun fact: 'Bookkeeper' is one of the few English words with three consecutive double letters.", ar: "معلومة: bookkeeper من أندر الكلمات اللي فيها 3 حروف مزدوجة متتالية." },
  { en: "Every word you learn is a small door to a new idea.", ar: "كل كلمة بتتعلمها هي باب صغير لفكرة جديدة." },
];

export function getRandomMotivation(excludeEn) {
  const options = excludeEn ? POOL.filter((q) => q.en !== excludeEn) : POOL;
  return options[Math.floor(Math.random() * options.length)];
}
