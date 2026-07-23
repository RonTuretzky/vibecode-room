import * as react from 'react';

interface FormattedDecimalNumberProps {
    value: number | string;
    className?: string;
    integralPartClassName?: string;
    decimalPartClassName?: string;
    withParkIcon?: boolean;
    parkIconClassName?: string;
    parkSize?: number;
    unit?: string;
}
declare function FormattedDecimalNumber({ value, className, integralPartClassName, decimalPartClassName, withParkIcon, parkIconClassName, parkSize, unit, }: FormattedDecimalNumberProps): react.JSX.Element;

export { FormattedDecimalNumber };
