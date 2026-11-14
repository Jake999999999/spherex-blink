def test_science_stack_imports():
    # Application Control on this PC blocks some DLLs (scikit-learn); make sure ours load.
    import astropy.io.fits  # noqa: F401
    import astropy.wcs  # noqa: F401
    import numpy  # noqa: F401
    import scipy.ndimage  # noqa: F401

    import spherex_blink

    assert spherex_blink.__version__
