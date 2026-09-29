/** Shared capacity contract for the PPTX renderer and browser preview. */
export const CAREER_PAGE_CAPACITY = 6;
export const CAREER_PHOTO_CAPACITY = 3;

export function careerLayout(count: number, hasImage: boolean) {
  const safeCount = Math.min(CAREER_PAGE_CAPACITY, Math.max(0, count));
  const showImage = hasImage && safeCount <= CAREER_PHOTO_CAPACITY;
  const columns = showImage || safeCount <= CAREER_PHOTO_CAPACITY ? 1 : 2;
  return { showImage, columns, rowsPerColumn: Math.max(1, Math.ceil(safeCount / columns)) };
}
