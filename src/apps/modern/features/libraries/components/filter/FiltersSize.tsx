import React, { FC, useCallback } from 'react';
import FormControlLabel from '@mui/material/FormControlLabel';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';

import { SIZE_BUCKETS } from 'utils/customFilters';
import type { LibraryViewSettings } from 'types/library';

interface FiltersSizeProps {
    libraryViewSettings: LibraryViewSettings;
    setLibraryViewSettings: React.Dispatch<React.SetStateAction<LibraryViewSettings>>;
}

const FiltersSize: FC<FiltersSizeProps> = ({ libraryViewSettings, setLibraryViewSettings }) => {
    const selected = libraryViewSettings?.Filters?.Size ?? 'any';

    const onChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
        const value = event.target.value;
        setLibraryViewSettings((prevState) => ({
            ...prevState,
            StartIndex: 0,
            Filters: {
                ...prevState.Filters,
                Size: value === 'any' ? undefined : value
            }
        }));
    }, [setLibraryViewSettings]);

    return (
        <RadioGroup value={selected} onChange={onChange}>
            <FormControlLabel value='any' control={<Radio />} label='Any size' />
            {SIZE_BUCKETS.map(bucket => (
                <FormControlLabel key={bucket.value} value={bucket.value} control={<Radio />} label={bucket.label} />
            ))}
        </RadioGroup>
    );
};

export default FiltersSize;
