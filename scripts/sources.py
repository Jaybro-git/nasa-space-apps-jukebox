"""Source files, copied verbatim from the NASA SVS pages (checked 2026-11-14)."""

SVS = "https://svs.gsfc.nasa.gov"

SST = {
    "page": f"{SVS}/3912/",
    "frames_dir": f"{SVS}/vis/a000000/a003900/a003912/frames/2048x1024_1x1_30p/orig/",
    "frame_pattern": r"flat_global_ecco2_2028x1024\.\d+\.tif",
    "colorbar": f"{SVS}/vis/a000000/a003900/a003912/sst_ecco2_cbar.png",
    "movie": f"{SVS}/vis/a000000/a003900/a003912/ecco2_sst_flow.mp4",
    "movie_small": f"{SVS}/vis/a000000/a003900/a003912/ecco2_sst_flow.m4v",  # 640x320, 12.1 MB
    "start": "2007-03-25T12:00Z",
    "end": "2008-03-03T12:00Z",
}

NIGHTLIGHTS = {
    "page": f"{SVS}/5313/",
    "movie": f"{SVS}/vis/a000000/a005300/a005313/nightlights_flat_series_and_change_wZooms_13_EIC_2160p30_h265.mp4",
}

LIGHTNING = {
    "page": f"{SVS}/5011/",
    "movie": f"{SVS}/vis/a000000/a005000/a005011/iss_lightning_sos_yearly_07312023_2048p60.mp4",
    "start": "2017-01-01",
    "end": "2023-07-31",
}

# Instrument samples, all CC BY 3.0. File names are read from the GitHub API at build time.
#   Salamander Grand Piano (Alexander Holm) via Tone.js: github.com/Tonejs/audio
#   tonejs-instruments (Nicholaus Brosowsky): github.com/nbrosowsky/tonejs-instruments
SAMPLE_SOURCES = {
    # name: (GitHub contents API listing, public base URL, midi range, min spacing in semitones)
    "piano": ("https://api.github.com/repos/Tonejs/audio/contents/salamander",
              "https://tonejs.github.io/audio/salamander/", (36, 96), 6),
    "cello": ("https://api.github.com/repos/nbrosowsky/tonejs-instruments/contents/samples/cello",
              "https://nbrosowsky.github.io/tonejs-instruments/samples/cello/", (36, 72), 5),
    "violin": ("https://api.github.com/repos/nbrosowsky/tonejs-instruments/contents/samples/violin",
               "https://nbrosowsky.github.io/tonejs-instruments/samples/violin/", (55, 96), 5),
    "harp": ("https://api.github.com/repos/nbrosowsky/tonejs-instruments/contents/samples/harp",
             "https://nbrosowsky.github.io/tonejs-instruments/samples/harp/", (40, 96), 5),
    "flute": ("https://api.github.com/repos/nbrosowsky/tonejs-instruments/contents/samples/flute",
              "https://nbrosowsky.github.io/tonejs-instruments/samples/flute/", (60, 96), 5),
    "contrabass": ("https://api.github.com/repos/nbrosowsky/tonejs-instruments/contents/samples/contrabass",
                   "https://nbrosowsky.github.io/tonejs-instruments/samples/contrabass/", (28, 60), 5),
}

# Night-mode sky: NASA SVS Deep Star Maps 2020 (public domain), galactic coordinates.
SKY = {
    "page": f"{SVS}/4851/",
    "starmap": f"{SVS}/vis/a000000/a004800/a004851/starmap_2020_4k_gal_print.jpg",
}

# Earth atlas: NASA Blue Marble Next Generation, December 2004, topography + bathymetry
# (public domain) and Natural Earth 1:50m admin-0 countries (public domain).
BMNG = "https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-topography/december"
EARTH = {
    "page": "https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/",
    "blue_marble": f"{BMNG}/world.topo.200412.3x5400x2700.jpg",
    "blue_marble_hi": f"{BMNG}/world.topo.200412.3x21600x10800.jpg",
    "countries": "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson",
    # NOAA ETOPO1 (ice surface, cell registered): land elevation and ocean depth, 1 arc-minute
    "etopo1": "https://www.ngdc.noaa.gov/mgg/global/relief/ETOPO1/data/ice_surface/cell_registered/georeferenced_tiff/ETOPO1_Ice_c_geotiff.zip",
}

# GEOS aerosols (SVS 5669): one EIC still, plate carree stretched to 16:9, legend by colour.
AEROSOLS = {
    "page": f"{SVS}/5669/",
    "image": f"{SVS}/vis/a000000/a005600/a005669/Aerosols_2025-08-19T20_00_00_3840x2160.png",
    "legend": f"{SVS}/vis/a000000/a005600/a005669/Aerosols_cbar.png",
}

# Real clouds for the Earth globe: one day of MODIS true colour (Terra + Aqua) from NASA GIBS.
GIBS_WMS = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1&SRS=EPSG:4326&BBOX=-180,-90,180,90&WIDTH=2048&HEIGHT=1024&FORMAT=image/jpeg"
CLOUDS = {
    "date": "2024-07-15",
    "layers": {
        "terra": f"{GIBS_WMS}&LAYERS=MODIS_Terra_CorrectedReflectance_TrueColor&TIME=2024-07-15",
        "aqua": f"{GIBS_WMS}&LAYERS=MODIS_Aqua_CorrectedReflectance_TrueColor&TIME=2024-07-15",
    },
}
