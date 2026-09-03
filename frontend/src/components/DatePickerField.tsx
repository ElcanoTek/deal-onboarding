// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ElcanoTek, Inc.

import { useEffect, useRef } from 'react'
import flatpickr from 'flatpickr'
import type { Instance as FlatpickrInstance } from 'flatpickr/dist/types/instance'

interface Props {
  id: string
  value: string
  onChange: (value: string) => void
  minDate?: string
  /** Red-outline the input when an audit failure targets this date field. */
  invalid?: boolean
}

export function DatePickerField({ id, value, onChange, minDate, invalid }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const pickerRef = useRef<FlatpickrInstance | null>(null)
  const onChangeRef = useRef(onChange)

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    const input = inputRef.current

    if (!input) {
      return
    }

    const picker = flatpickr(input, {
      allowInput: true,
      clickOpens: true,
      dateFormat: 'Y-m-d',
      disableMobile: true,
      defaultDate: value || undefined,
      minDate: minDate || undefined,
      onChange: (_selectedDates, dateStr) => {
        onChangeRef.current(dateStr)
      },
    })

    pickerRef.current = picker

    return () => {
      picker.destroy()

      if (pickerRef.current === picker) {
        pickerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    pickerRef.current?.set('minDate', minDate || undefined)
  }, [minDate])

  useEffect(() => {
    const picker = pickerRef.current

    if (!picker) {
      return
    }

    if (!value) {
      picker.clear(false)
      return
    }

    if (picker.input.value !== value) {
      picker.setDate(value, false)
    }
  }, [value])

  return (
    <div className="date-input-wrap">
      <input
        ref={inputRef}
        id={id}
        type="text"
        inputMode="numeric"
        className={`field-input custom-datepicker${invalid ? ' field-input--error' : ''}`}
        value={value}
        onChange={event => onChange(event.target.value)}
        placeholder="YYYY-MM-DD"
        aria-invalid={invalid ? true : undefined}
      />
      <svg className="date-input-icon" aria-hidden="true">
        <use href="/design-system/icons/core-icons.svg#calendar" />
      </svg>
    </div>
  )
}
