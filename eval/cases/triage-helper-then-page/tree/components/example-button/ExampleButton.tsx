import "./ExampleButton.css";

export type ExampleButtonVariant = "primary" | "secondary";

export type ExampleButtonProps = {
  label: string;
  variant?: ExampleButtonVariant;
  disabled?: boolean;
};

export function ExampleButton({
  label,
  variant = "primary",
  disabled = false,
}: ExampleButtonProps) {
  return (
    <button
      type="button"
      className={`example-button example-button--${variant}`}
      disabled={disabled}
    >
      {label}
    </button>
  );
}
