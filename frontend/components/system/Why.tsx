/**
 * Why an element is lit while another is chosen: the words of the relations
 * that lead from the choice to it ("performed by", "callable by"), as chips.
 * Nothing when it is not lit.
 */
export function Why({ labels }: { labels: readonly string[] }) {
  if (labels.length === 0) return null;
  return (
    <span class="el-why">
      {labels.map((label) => <span key={label} class="chip">{label}</span>)}
    </span>
  );
}
