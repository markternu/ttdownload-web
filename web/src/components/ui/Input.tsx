import { forwardRef, useId } from 'react'
import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react'
import { cn } from '../../lib/cn'

const FIELD_BASE =
  'w-full rounded-xl border border-slate-200 bg-white px-3.5 text-sm text-slate-900 placeholder:text-slate-400 ' +
  'transition-colors focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/25 ' +
  'disabled:cursor-not-allowed disabled:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 ' +
  'dark:placeholder:text-slate-500 dark:disabled:bg-slate-800/60'

export interface FieldProps {
  label: ReactNode
  hint?: ReactNode
  error?: ReactNode
  htmlFor?: string
  children: ReactNode
  className?: string
}

export function Field({ label, hint, error, htmlFor, children, className }: FieldProps) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <label
        htmlFor={htmlFor}
        className="block text-xs font-medium text-slate-600 dark:text-slate-300"
      >
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
      ) : hint ? (
        <p className="text-xs text-slate-400 dark:text-slate-500">{hint}</p>
      ) : null}
    </div>
  )
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: ReactNode
  hint?: ReactNode
  error?: ReactNode
  leading?: ReactNode
  trailing?: ReactNode
  wrapperClassName?: string
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, leading, trailing, className, wrapperClassName, id, ...rest },
  ref,
) {
  const autoId = useId()
  const inputId = id ?? autoId
  const control = (
    <div className={cn('relative', wrapperClassName)}>
      {leading ? (
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
          {leading}
        </span>
      ) : null}
      <input
        ref={ref}
        id={inputId}
        className={cn(
          FIELD_BASE,
          'h-10',
          leading && 'pl-9',
          trailing && 'pr-10',
          error && 'border-red-400 focus:border-red-500 focus:ring-red-500/20',
          className,
        )}
        {...rest}
      />
      {trailing ? (
        <span className="absolute right-2 top-1/2 -translate-y-1/2">{trailing}</span>
      ) : null}
    </div>
  )

  if (!label && !hint && !error) return control

  return (
    <Field label={label} hint={hint} error={error} htmlFor={inputId}>
      {control}
    </Field>
  )
})

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: ReactNode
  hint?: ReactNode
  error?: ReactNode
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, hint, error, className, id, ...rest },
  ref,
) {
  const autoId = useId()
  const textareaId = id ?? autoId
  const control = (
    <textarea
      ref={ref}
      id={textareaId}
      className={cn(
        FIELD_BASE,
        'min-h-[120px] resize-y py-2.5 leading-relaxed',
        error && 'border-red-400 focus:border-red-500 focus:ring-red-500/20',
        className,
      )}
      {...rest}
    />
  )
  if (!label && !hint && !error) return control
  return (
    <Field label={label} hint={hint} error={error} htmlFor={textareaId}>
      {control}
    </Field>
  )
})

export interface SelectOption {
  value: string | number
  label: string
  disabled?: boolean
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: ReactNode
  hint?: ReactNode
  error?: ReactNode
  options: SelectOption[]
  placeholder?: string
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, hint, error, options, placeholder, className, id, ...rest },
  ref,
) {
  const autoId = useId()
  const selectId = id ?? autoId
  const control = (
    <select
      ref={ref}
      id={selectId}
      className={cn(FIELD_BASE, 'h-10 cursor-pointer pr-8', className)}
      {...rest}
    >
      {placeholder ? <option value="">{placeholder}</option> : null}
      {options.map((option) => (
        <option key={String(option.value)} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  )
  if (!label && !hint && !error) return control
  return (
    <Field label={label} hint={hint} error={error} htmlFor={selectId}>
      {control}
    </Field>
  )
})

export interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: ReactNode
  description?: ReactNode
  disabled?: boolean
  className?: string
}

export function Switch({ checked, onChange, label, description, disabled, className }: SwitchProps) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-center justify-between gap-4',
        disabled && 'cursor-not-allowed opacity-60',
        className,
      )}
    >
      <span className="min-w-0">
        {label ? (
          <span className="block text-sm font-medium text-slate-700 dark:text-slate-200">{label}</span>
        ) : null}
        {description ? (
          <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">{description}</span>
        ) : null}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900',
          checked ? 'bg-brand-600' : 'bg-slate-300 dark:bg-slate-700',
        )}
      >
        <span
          className={cn(
            'inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform',
            checked ? 'translate-x-5' : 'translate-x-0.5',
          )}
        />
      </button>
    </label>
  )
}
