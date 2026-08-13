'use client';

import * as React from 'react';
import { Field, Select } from '@orbit/ui';

/**
 * Time-zone picker.
 *
 * Scheduling correctness depends on this value (SRS §36), and the server
 * rejects anything `Intl` cannot resolve — so the options come from `Intl`
 * itself rather than a hand-kept list that would drift as zones are added and
 * renamed. `supportedValuesOf` is not in every runtime, so a browser without it
 * falls back to a shortlist that still contains the viewer's own zone.
 *
 * The default is the viewer's zone, because an agency setting up its first
 * client is almost always sitting in the zone it wants.
 */

const FALLBACK = [
  'UTC',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Los_Angeles',
  'Asia/Ho_Chi_Minh',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
];

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function zones(current: string): string[] {
  const supported =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : FALLBACK;

  // `current` may be the viewer's own zone even when the list omits it.
  return supported.includes(current) ? [...supported] : [current, ...supported];
}

export interface TimezoneFieldProps {
  id: string;
  label?: string;
  hint?: React.ReactNode;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  error?: string;
}

export function TimezoneField({
  id,
  label = 'Time zone',
  hint,
  value,
  onChange,
  disabled,
  error,
}: TimezoneFieldProps) {
  const options = React.useMemo(() => zones(value), [value]);

  return (
    <Field
      label={label}
      htmlFor={id}
      required
      {...(hint ? { hint } : {})}
      {...(error ? { error } : {})}
    >
      <Select
        id={id}
        name={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((zone) => (
          <option key={zone} value={zone}>
            {zone.replace(/_/g, ' ')}
          </option>
        ))}
      </Select>
    </Field>
  );
}
